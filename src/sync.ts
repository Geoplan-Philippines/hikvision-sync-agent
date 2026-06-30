import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import hikvision from './hikvision.js';
import { writeLog as log } from './logger.js';


const PAGE_SIZE = 30;
const MAX_PAGES = 100;
const MAX_SYNCED_IDS = 20_000;
const MAX_RETRY_ATTEMPTS = 10;
const MAX_VPS_BATCH_SIZE = 100;
const RETRY_BASE_MS = 10_000;
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const REALTIME_LOOKBACK_MS = 5 * 60 * 1000;
const REALTIME_CURSOR_OVERLAP_MS = 10 * 1000;
const REGISTERED_IDS_CACHE_MS = 60 * 1000;
const STATE_VERSION = 2;

const statePath = path.resolve(process.env.SYNC_STATE_FILE ?? path.join(process.cwd(), '.sync-state.json'));

type UnknownRecord = Record<string, unknown>;

export interface BiometricEvent {
  externalId: string;
  biometricsId: string;
  timestamp: string;
}

export type SyncSource =
  | 'scheduled'
  | 'morning_catch_up'
  | 'manual'
  | 'watchdog'
  | 'biometric_trigger';

interface RetryItem {
  event: BiometricEvent;
  attempts: number;
  nextAttemptAt: string;
}

interface SyncState {
  version: number;
  syncedIds: string[];
  lastSeenAt: string | null;
  retryQueue: RetryItem[];
}

interface FetchResult {
  events: UnknownRecord[];
  complete: boolean;
}

interface RegisteredIdsCache {
  ids: Set<string>;
  expiresAt: number;
}

type BatchIngestStatus = 'ingested' | 'duplicate' | 'unknown_biometrics_id';

interface BatchIngestEventResult {
  externalId: string;
  status: BatchIngestStatus;
}

interface BatchIngestResponse {
  ingested: number;
  duplicates: number;
  unknown: number;
  results: BatchIngestEventResult[];
}

let running = false;
let registeredIdsCache: RegisteredIdsCache | null = null;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function localName(key: string): string {
  return key.includes(':') ? key.slice(key.lastIndexOf(':') + 1) : key;
}

function property(object: unknown, name: string): unknown {
  if (!isRecord(object)) return undefined;
  const key = Object.keys(object).find((candidate) => localName(candidate) === name);
  return key ? object[key] : undefined;
}

function asArray(value: unknown): unknown[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function looksLikeEvent(value: unknown): value is UnknownRecord {
  return isRecord(value) && (
    property(value, 'time') != null ||
    property(value, 'employeeNoString') != null ||
    property(value, 'serialNo') != null
  );
}

export function extractEvents(data: unknown): UnknownRecord[] {
  const acsEvent = property(data, 'AcsEvent') ?? data;
  const infoList = property(acsEvent, 'InfoList');
  if (!infoList) return [];

  const extracted: unknown[] = [];
  for (const item of asArray(infoList)) {
    if (looksLikeEvent(item)) extracted.push(item);
    extracted.push(...asArray(property(item, 'AcsEventInfo')));
    extracted.push(...asArray(property(item, 'Info')));
  }
  return extracted.filter(looksLikeEvent);
}

function scalar(value: unknown): string {
  if (Array.isArray(value)) return scalar(value[0]);
  if (isRecord(value) && '_' in value) return scalar(value._);
  return value == null ? '' : String(value).trim();
}

export function normalizeEvent(raw: UnknownRecord): BiometricEvent | null {
  const biometricsId = scalar(
    property(raw, 'employeeNoString') ?? property(raw, 'employeeNo') ?? property(raw, 'cardNo'),
  );
  const deviceTime = scalar(property(raw, 'time') ?? property(raw, 'dateTime'));
  const parsedTime = new Date(deviceTime);
  if (!biometricsId || !deviceTime || Number.isNaN(parsedTime.getTime())) return null;

  const serialNo = scalar(property(raw, 'serialNo'));
  const fingerprint = serialNo || createHash('sha256').update(JSON.stringify({
    biometricsId,
    deviceTime,
    cardNo: scalar(property(raw, 'cardNo')),
    major: scalar(property(raw, 'major')),
    minor: scalar(property(raw, 'minor')),
  })).digest('hex').slice(0, 24);

  return {
    externalId: `hik:${fingerprint}:${deviceTime}`,
    biometricsId,
    timestamp: parsedTime.toISOString(),
  };
}

function eventMetadata(data: unknown): { status: string; total: number } {
  const acsEvent = property(data, 'AcsEvent') ?? data;
  return {
    status: scalar(property(acsEvent, 'responseStatusStrg')),
    total: Number(scalar(property(acsEvent, 'totalMatches'))) || 0,
  };
}

export function formatManilaTime(date: Date): string {
  const shifted = new Date(date.getTime() + MANILA_OFFSET_MS);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}+08:00`;
}

function manilaInstantForTime(now: Date, time: string): Date {
  const local = new Date(now.getTime() + MANILA_OFFSET_MS);
  const [hour, minute] = time.split(':').map(Number);
  return new Date(
    Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate(),
      hour,
      minute,
    ) - MANILA_OFFSET_MS,
  );
}

export function dailySyncWindow(now: Date): { start: Date; end: Date } {
  return {
    start: manilaInstantForTime(now, process.env.SYNC_START_TIME ?? '09:00'),
    end: manilaInstantForTime(now, process.env.SYNC_END_TIME ?? '20:00'),
  };
}

export function syncAllowedAt(
  source: SyncSource,
  now: Date,
  dailyWindow: { start: Date; end: Date },
): boolean {
  return source === 'biometric_trigger' ||
    source === 'watchdog' ||
    (now >= dailyWindow.start && now < dailyWindow.end);
}

export function eventWindowStart(
  lastSeenAt: string | null,
  dailyWindow: { start: Date; end: Date },
  source: SyncSource = 'scheduled',
  now: Date = new Date(),
): { start: Date; mode: 'morning_catch_up' | 'interval_rescan' | 'realtime_cursor' } {
  if (source === 'biometric_trigger' || source === 'watchdog') {
    const floor = now.getTime() - REALTIME_LOOKBACK_MS;
    const lastSeen = lastSeenAt ? new Date(lastSeenAt) : null;
    const cursor = lastSeen && !Number.isNaN(lastSeen.getTime())
      ? lastSeen.getTime() - REALTIME_CURSOR_OVERLAP_MS
      : floor;
    return {
      start: new Date(Math.max(floor, cursor)),
      mode: 'realtime_cursor',
    };
  }
  const lastSeen = lastSeenAt ? new Date(lastSeenAt) : null;
  const needsMorningCatchUp = !lastSeen ||
    Number.isNaN(lastSeen.getTime()) ||
    lastSeen < dailyWindow.start;
  return needsMorningCatchUp
    ? { start: new Date(dailyWindow.end.getTime() - DAY_MS), mode: 'morning_catch_up' }
    : { start: dailyWindow.start, mode: 'interval_rescan' };
}

function isBiometricEvent(value: unknown): value is BiometricEvent {
  return isRecord(value) &&
    typeof value.externalId === 'string' &&
    typeof value.biometricsId === 'string' &&
    typeof value.timestamp === 'string';
}

function isRetryItem(value: unknown): value is RetryItem {
  return isRecord(value) &&
    isBiometricEvent(value.event) &&
    typeof value.attempts === 'number' &&
    Number.isInteger(value.attempts) &&
    typeof value.nextAttemptAt === 'string';
}

async function loadState(): Promise<SyncState> {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, 'utf8')) as unknown;
    const record = isRecord(parsed) ? parsed : {};
    const isCurrentVersion = record.version === STATE_VERSION;
    return {
      version: STATE_VERSION,
      syncedIds: isCurrentVersion && Array.isArray(record.syncedIds)
        ? record.syncedIds.filter((id): id is string => typeof id === 'string').slice(-MAX_SYNCED_IDS)
        : [],
      lastSeenAt: typeof record.lastSeenAt === 'string' ? record.lastSeenAt : null,
      retryQueue: Array.isArray(record.retryQueue) ? record.retryQueue.filter(isRetryItem) : [],
    };
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code !== 'ENOENT') {
      log('error', 'ERROR DETAILS', {
        stage: 'state_load',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return { version: STATE_VERSION, syncedIds: [], lastSeenAt: null, retryQueue: [] };
  }
}

async function saveState(state: SyncState): Promise<void> {
  const temporaryPath = `${statePath}.tmp`;
  const payload = JSON.stringify({
    ...state,
    syncedIds: state.syncedIds.slice(-MAX_SYNCED_IDS),
  }, null, 2);
  try {
    await fs.writeFile(temporaryPath, payload, 'utf8');
    await fs.rename(temporaryPath, statePath);
  } catch (error) {
    log('error', 'ERROR DETAILS', {
      stage: 'state_save',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function apiUrl(path: string): string {
  const base = (process.env.VPS_URL ?? '').replace(/\/+$/, '');
  if (!base) throw new Error('Missing required environment variable: VPS_URL');
  return `${base}/attendance/${path}`;
}

async function fetchRegisteredBiometricIds(): Promise<Set<string>> {
  const now = Date.now();
  if (registeredIdsCache && registeredIdsCache.expiresAt > now) {
    log('info', 'REGISTERED BIOMETRIC IDS', {
      count: registeredIdsCache.ids.size,
      source: 'cache',
      expiresInMs: registeredIdsCache.expiresAt - now,
    });
    return registeredIdsCache.ids;
  }

  const response = await axios.get(apiUrl('biometrics/ids'), {
    timeout: Number(process.env.VPS_TIMEOUT_MS) || 8_000,
  });
  const envelope = response.data as unknown;
  const payload = isRecord(envelope) && isRecord(envelope.data) ? envelope.data : envelope;
  const ids = isRecord(payload) ? payload.biometricsIds : undefined;
  if (!Array.isArray(ids)) {
    throw new Error('VPS biometric ID response is malformed.');
  }
  const registeredIds = new Set(
    ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0),
  );
  registeredIdsCache = { ids: registeredIds, expiresAt: now + REGISTERED_IDS_CACHE_MS };
  log('info', 'REGISTERED BIOMETRIC IDS', {
    count: registeredIds.size,
    source: 'vps',
    cacheTtlMs: REGISTERED_IDS_CACHE_MS,
  });
  return registeredIds;
}

export function parseBatchIngestResponse(value: unknown): BatchIngestResponse {
  const payload = isRecord(value) && isRecord(value.data) ? value.data : value;
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    throw new Error('VPS biometric batch response is malformed.');
  }
  const results = payload.results.filter((result): result is BatchIngestEventResult => {
    if (!isRecord(result) || typeof result.externalId !== 'string') return false;
    return result.status === 'ingested' ||
      result.status === 'duplicate' ||
      result.status === 'unknown_biometrics_id';
  });
  if (results.length !== payload.results.length) {
    throw new Error('VPS biometric batch results are malformed.');
  }
  return {
    ingested: Number(payload.ingested) || 0,
    duplicates: Number(payload.duplicates) || 0,
    unknown: Number(payload.unknown) || 0,
    results,
  };
}

async function postEventBatch(events: BiometricEvent[]): Promise<BatchIngestResponse> {
  const response = await axios.post(apiUrl('events/biometric/batch'), { events }, {
    timeout: Number(process.env.VPS_TIMEOUT_MS) || 8_000,
  });
  return parseBatchIngestResponse(response.data as unknown);
}

async function fetchAllEvents(start: Date, end: Date): Promise<FetchResult> {
  if (!hikvision.beginEventSearch()) {
    return { events: [], complete: false };
  }
  const searchId = String(Math.floor(Math.random() * 1_000_000_000));
  const events: UnknownRecord[] = [];
  let position = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await hikvision.getAttendanceEvents({
      searchId,
      position,
      maxResults: PAGE_SIZE,
      startTime: formatManilaTime(start),
      endTime: formatManilaTime(end),
    });
    if (!data) return { events, complete: false };

    const pageEvents = extractEvents(data);
    events.push(...pageEvents);
    position += pageEvents.length;
    const metadata = eventMetadata(data);

    if (pageEvents.length === 0 || (metadata.status !== 'MORE' && position >= metadata.total)) {
      return { events, complete: true };
    }
  }

  log('warn', 'PAGE LIMIT REACHED', { maxPages: MAX_PAGES, events: events.length });
  return { events, complete: false };
}

function enqueueRetry(state: SyncState, event: BiometricEvent, previousAttempts = 0): void {
  const existing = state.retryQueue.find((item) => item.event.externalId === event.externalId);
  const attempts = Math.max(existing?.attempts ?? 0, previousAttempts) + 1;
  if (attempts >= MAX_RETRY_ATTEMPTS) {
    log('error', 'ERROR DETAILS', { stage: 'retry_exhausted', externalId: event.externalId, attempts });
    state.retryQueue = state.retryQueue.filter((item) => item.event.externalId !== event.externalId);
    return;
  }

  const retry: RetryItem = {
    event,
    attempts,
    nextAttemptAt: new Date(
      Date.now() + Math.min(RETRY_BASE_MS * (2 ** (attempts - 1)), 300_000),
    ).toISOString(),
  };
  state.retryQueue = state.retryQueue.filter((item) => item.event.externalId !== event.externalId);
  state.retryQueue.push(retry);
}

async function deliverBatch(
  state: SyncState,
  events: BiometricEvent[],
  previousAttempts = new Map<string, number>(),
): Promise<number> {
  if (events.length === 0) return 0;
  if (events.length > MAX_VPS_BATCH_SIZE) {
    let ingested = 0;
    for (let offset = 0; offset < events.length; offset += MAX_VPS_BATCH_SIZE) {
      ingested += await deliverBatch(
        state,
        events.slice(offset, offset + MAX_VPS_BATCH_SIZE),
        previousAttempts,
      );
    }
    return ingested;
  }
  try {
    const response = await postEventBatch(events);
    const resultByExternalId = new Map(response.results.map((result) => [result.externalId, result]));
    if (events.some((event) => !resultByExternalId.has(event.externalId))) {
      throw new Error('VPS biometric batch response omitted an event result.');
    }

    let ingested = 0;
    for (const event of events) {
      const result = resultByExternalId.get(event.externalId)!;
      if (result.status === 'ingested' || result.status === 'duplicate') {
        if (!state.syncedIds.includes(event.externalId)) state.syncedIds.push(event.externalId);
        state.retryQueue = state.retryQueue.filter(
          (item) => item.event.externalId !== event.externalId,
        );
        if (result.status === 'ingested') ingested += 1;
      } else {
        enqueueRetry(state, event, previousAttempts.get(event.externalId) ?? 0);
      }
    }
    log('info', 'VPS BATCH RESULT', {
      submitted: events.length,
      ingested: response.ingested,
      duplicates: response.duplicates,
      unknown: response.unknown,
    });
    return ingested;
  } catch (error) {
    const response = axios.isAxiosError(error) ? error.response : undefined;
    log('error', 'ERROR DETAILS', {
      stage: 'vps_batch_post',
      count: events.length,
      status: response?.status,
      message: error instanceof Error ? error.message : String(error),
    });
    for (const event of events) {
      enqueueRetry(state, event, previousAttempts.get(event.externalId) ?? 0);
    }
    return 0;
  }
}

async function processRetries(state: SyncState): Promise<number> {
  const due = state.retryQueue.filter((item) => Date.parse(item.nextAttemptAt) <= Date.now());
  return deliverBatch(
    state,
    due.map((item) => item.event),
    new Map(due.map((item) => [item.event.externalId, item.attempts])),
  );
}

export default async function sync(source: SyncSource = 'scheduled'): Promise<void> {
  if (running) {
    log('warn', 'SYNC SKIPPED', { reason: 'previous_cycle_running' });
    return;
  }
  running = true;

  try {
    log('info', 'SYNC CYCLE STARTED', { source });
    const now = new Date();
    const dailyWindow = dailySyncWindow(now);
    if (!syncAllowedAt(source, now, dailyWindow) && now < dailyWindow.start) {
      log('info', 'SYNC WINDOW NOT OPEN', {
        opensAt: dailyWindow.start.toISOString(),
        opensAtManila: formatManilaTime(dailyWindow.start),
        reason: 'No VPS or Hikvision request was sent.',
      });
      return;
    }
    if (!syncAllowedAt(source, now, dailyWindow) && now >= dailyWindow.end) {
      log('info', 'SYNC WINDOW CLOSED', {
        closedAt: dailyWindow.end.toISOString(),
        closedAtManila: formatManilaTime(dailyWindow.end),
        reason: 'No VPS or Hikvision request was sent.',
      });
      return;
    }

    const state = await loadState();
    const registeredIds = await fetchRegisteredBiometricIds();
    const queuedBeforeFiltering = state.retryQueue.length;
    state.retryQueue = state.retryQueue.filter((item) => registeredIds.has(item.event.biometricsId));
    const skippedQueued = queuedBeforeFiltering - state.retryQueue.length;
    if (skippedQueued > 0) {
      log('warn', 'UNREGISTERED BIOMETRIC EVENTS SKIPPED', { count: skippedQueued, source: 'retry_queue' });
    }
    let synced = await processRetries(state);
    const end = now;
    const eventWindow = eventWindowStart(state.lastSeenAt, dailyWindow, source, end);
    const start = eventWindow.start;

    const result = await fetchAllEvents(start, end);
    const normalized = result.events
      .map(normalizeEvent)
      .filter((event): event is BiometricEvent => event !== null);
    const unique = [...new Map(normalized.map((event) => [event.externalId, event])).values()];
    const known = unique.filter((event) => registeredIds.has(event.biometricsId));
    const syncedIds = new Set(state.syncedIds);
    const queuedIds = new Set(state.retryQueue.map((item) => item.event.externalId));
    const pending = known.filter(
      (event) => !syncedIds.has(event.externalId) && !queuedIds.has(event.externalId),
    );

    log('info', 'EVENTS FOUND', {
      raw: result.events.length,
      valid: unique.length,
      registered: known.length,
      skippedUnregistered: unique.length - known.length,
      pending: pending.length,
      windowStart: start.toISOString(),
      windowEnd: end.toISOString(),
      windowStartManila: formatManilaTime(start),
      windowEndManila: formatManilaTime(end),
      mode: eventWindow.mode,
    });

    synced += await deliverBatch(state, pending);
    if (result.complete) state.lastSeenAt = end.toISOString();
    await saveState(state);
    log('info', 'SYNC SUCCESS COUNT', { synced, queued: state.retryQueue.length });
  } catch (error) {
    log('error', 'ERROR DETAILS', {
      stage: 'sync_cycle',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  } finally {
    running = false;
  }
}
