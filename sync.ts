import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import hikvision from './hikvision.js';

const PAGE_SIZE = 30;
const MAX_PAGES = 100;
const MAX_SYNCED_IDS = 20_000;
const MAX_RETRY_ATTEMPTS = 10;
const RETRY_BASE_MS = 10_000;
const OVERLAP_MS = 5 * 60 * 1000;
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.basename(moduleDirectory) === 'dist'
  ? path.dirname(moduleDirectory)
  : moduleDirectory;
const statePath = path.resolve(projectDirectory, process.env.SYNC_STATE_FILE ?? '.sync-state.json');

type LogLevel = 'info' | 'warn' | 'error';
type UnknownRecord = Record<string, unknown>;

export interface BiometricEvent {
  externalId: string;
  biometricsId: string;
  timestamp: string;
}

interface RetryItem {
  event: BiometricEvent;
  attempts: number;
  nextAttemptAt: string;
}

interface SyncState {
  syncedIds: string[];
  lastSeenAt: string | null;
  retryQueue: RetryItem[];
}

interface FetchResult {
  events: UnknownRecord[];
  complete: boolean;
}

let running = false;

function log(level: LogLevel, event: string, details: UnknownRecord = {}): void {
  const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  method(JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...details }));
}

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

function initialWindowStart(now: Date): Date {
  const local = new Date(now.getTime() + MANILA_OFFSET_MS);
  const hour = local.getUTCHours() >= 9 ? 9 : 0;
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour) - MANILA_OFFSET_MS,
  );
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
    return {
      syncedIds: Array.isArray(record.syncedIds)
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
    return { syncedIds: [], lastSeenAt: null, retryQueue: [] };
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

function apiUrl(): string {
  const base = (process.env.VPS_URL ?? '').replace(/\/+$/, '');
  if (!base) throw new Error('Missing required environment variable: VPS_URL');
  return `${base}/attendance/event`;
}

async function postEvent(event: BiometricEvent): Promise<void> {
  await axios.post(apiUrl(), event, {
    timeout: Number(process.env.VPS_TIMEOUT_MS) || 8_000,
    validateStatus: (status) => (status >= 200 && status < 300) || status === 409,
  });
}

async function fetchAllEvents(start: Date, end: Date): Promise<FetchResult> {
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

async function deliver(state: SyncState, event: BiometricEvent, previousAttempts = 0): Promise<boolean> {
  try {
    await postEvent(event);
    state.syncedIds.push(event.externalId);
    state.retryQueue = state.retryQueue.filter((item) => item.event.externalId !== event.externalId);
    return true;
  } catch (error) {
    const response = axios.isAxiosError(error) ? error.response : undefined;
    log('error', 'ERROR DETAILS', {
      stage: 'vps_post',
      externalId: event.externalId,
      status: response?.status,
      message: error instanceof Error ? error.message : String(error),
      response: typeof response?.data === 'string' ? response.data.slice(0, 300) : response?.data,
    });
    enqueueRetry(state, event, previousAttempts);
    return false;
  }
}

async function processRetries(state: SyncState): Promise<number> {
  const due = state.retryQueue.filter((item) => Date.parse(item.nextAttemptAt) <= Date.now());
  let synced = 0;
  for (const item of due) {
    if (await deliver(state, item.event, item.attempts)) synced += 1;
  }
  return synced;
}

export default async function sync(): Promise<void> {
  if (running) {
    log('warn', 'SYNC SKIPPED', { reason: 'previous_cycle_running' });
    return;
  }
  running = true;

  try {
    const state = await loadState();
    let synced = await processRetries(state);
    const now = new Date();
    const storedStart = state.lastSeenAt ? new Date(state.lastSeenAt) : null;
    const start = storedStart && !Number.isNaN(storedStart.getTime())
      ? new Date(storedStart.getTime() - OVERLAP_MS)
      : initialWindowStart(now);

    const result = await fetchAllEvents(start, now);
    const normalized = result.events
      .map(normalizeEvent)
      .filter((event): event is BiometricEvent => event !== null);
    const unique = [...new Map(normalized.map((event) => [event.externalId, event])).values()];
    const syncedIds = new Set(state.syncedIds);
    const queuedIds = new Set(state.retryQueue.map((item) => item.event.externalId));
    const pending = unique.filter(
      (event) => !syncedIds.has(event.externalId) && !queuedIds.has(event.externalId),
    );

    log('info', 'EVENTS FOUND', {
      raw: result.events.length,
      valid: unique.length,
      pending: pending.length,
      windowStart: start.toISOString(),
      windowEnd: now.toISOString(),
    });

    for (const event of pending) {
      if (await deliver(state, event)) synced += 1;
    }
    if (result.complete) state.lastSeenAt = now.toISOString();
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
