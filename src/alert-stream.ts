import { randomBytes } from 'node:crypto';
import { buildDigestAuthorization, getErrorDetails, parseDigestChallenge } from './hikvision.js';
import {
  haltHikvisionAuthentication,
  isHikvisionAuthenticationHalted,
  onHikvisionAuthenticationHalted,
  onHikvisionAuthenticationResumed,
} from './hikvision-auth.js';
import { writeLog as log } from './logger.js';

const ALERT_STREAM_PATH = '/ISAPI/Event/notification/alertStream';
const DEFAULT_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const STABLE_CONNECTION_MS = 30_000;
const MAX_BUFFER_LENGTH = 1_000_000;
// Consecutive authenticated 401s tolerated (each reconnect rebuilds a fresh Digest
// handshake) before halting. A single 401 after long uptime is usually a stale nonce.
const MAX_CONSECUTIVE_AUTH_401 = 3;

export type ListenerState = 'connected' | 'reconnecting' | 'stopped' | 'authentication_halted';

export interface RealtimeListenerStatus {
  listenerState: ListenerState;
  lastRealtimeEvent: string | null;
  reconnectAttempt: number;
  lastListenerError: string | null;
}

export interface ParsedAlertMessage {
  format: 'json' | 'xml';
  value: unknown;
  body: string;
}

interface AlertStreamOptions {
  host?: string;
  username?: string;
  password?: string;
  onTrigger: () => Promise<void> | void;
  onStatusChange?: (status: RealtimeListenerStatus) => void;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  random?: () => number;
  debounceMs?: number;
  reconnectDelaysMs?: number[];
  connectionTimeoutMs?: number;
}

function parseBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary\s*=\s*(?:\x22([^\x22]+)\x22|'([^']+)'|([^;\s]+))/i);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').replace(/^--/, '') || null;
}

function jsonEnd(input: string, start: number): number | null {
  const opening = input[start];
  if (opening !== '{' && opening !== '[') return null;
  const stack = [opening];
  let quoted = false;
  let escaped = false;
  for (let index = start + 1; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '\x22') quoted = false;
      continue;
    }
    if (character === '\x22') quoted = true;
    else if (character === '{' || character === '[') stack.push(character);
    else if (character === '}' || character === ']') {
      const expected = character === '}' ? '{' : '[';
      if (stack.pop() !== expected) return start + 1;
      if (stack.length === 0) return index + 1;
    }
  }
  return null;
}

function xmlEnd(input: string, start: number): number | null {
  const root = input.slice(start).match(
    /^(?:<\?xml[\s\S]*?\?>\s*)*(?:<!--[\s\S]*?-->\s*)*<([A-Za-z_][\w:.-]*)\b[^>]*>/,
  );
  if (!root) return null;
  if (/\/\s*>$/.test(root[0])) return start + root[0].length;
  const rootName = root[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const closing = new RegExp(`</${rootName}\\s*>`, 'i');
  const restStart = start + root[0].length;
  const match = closing.exec(input.slice(restStart));
  return match ? restStart + match.index + match[0].length : null;
}

function structuredMessages(input: string): { messages: ParsedAlertMessage[]; remainder: string } {
  const messages: ParsedAlertMessage[] = [];
  let remainder = input;
  while (remainder.length > 0) {
    const starts = [remainder.search(/[\[{]/), remainder.indexOf('<')].filter((value) => value >= 0);
    if (starts.length === 0) return { messages, remainder: remainder.slice(-4_096) };
    const start = Math.min(...starts);
    if (start > 0) remainder = remainder.slice(start);
    if (remainder[0] === '{' || remainder[0] === '[') {
      const end = jsonEnd(remainder, 0);
      if (end === null) break;
      const body = remainder.slice(0, end);
      remainder = remainder.slice(end);
      try {
        messages.push({ format: 'json', value: JSON.parse(body) as unknown, body });
      } catch {
        remainder = body.slice(1) + remainder;
      }
      continue;
    }
    const end = xmlEnd(remainder, 0);
    if (end === null) break;
    const body = remainder.slice(0, end);
    messages.push({ format: 'xml', value: null, body });
    remainder = remainder.slice(end);
  }
  return { messages, remainder };
}

/** Incrementally separates multipart, JSON, and XML alert-stream messages. */
export class IncrementalAlertParser {
  private readonly decoder = new TextDecoder();
  private readonly boundary: string | null;
  private buffer = '';

  constructor(contentType = '') {
    this.boundary = parseBoundary(contentType);
  }

  push(chunk: Uint8Array | string): ParsedAlertMessage[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    if (this.buffer.length > MAX_BUFFER_LENGTH) this.buffer = this.buffer.slice(-MAX_BUFFER_LENGTH);
    return this.boundary ? this.consumeMultipart() : this.consumeStructured();
  }

  private consumeMultipart(): ParsedAlertMessage[] {
    const marker = `--${this.boundary}`;
    const messages: ParsedAlertMessage[] = [];
    const firstMarker = this.buffer.indexOf(marker);
    if (firstMarker < 0) return messages;
    if (firstMarker > 0) this.buffer = this.buffer.slice(firstMarker);
    while (this.buffer.startsWith(marker)) {
      const nextMarker = this.buffer.indexOf(marker, marker.length);
      if (nextMarker < 0) break;
      const part = this.buffer.slice(marker.length, nextMarker).replace(/^\r?\n/, '');
      this.buffer = this.buffer.slice(nextMarker);
      if (part.startsWith('--')) continue;
      const headerEnd = part.search(/\r?\n\r?\n/);
      const body = (headerEnd >= 0 ? part.slice(headerEnd).replace(/^\r?\n\r?\n/, '') : part)
        .replace(/\r?\n$/, '');
      messages.push(...structuredMessages(body).messages);
    }
    return messages;
  }

  private consumeStructured(): ParsedAlertMessage[] {
    const result = structuredMessages(this.buffer);
    this.buffer = result.remainder;
    return result.messages;
  }
}

function collectScalars(value: unknown, names: Set<string>, result: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectScalars(item, names, result);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const local = key.includes(':') ? key.slice(key.lastIndexOf(':') + 1) : key;
    if (names.has(local.toLowerCase()) && ['string', 'number', 'boolean'].includes(typeof nested)) {
      result.push(String(nested).trim());
    }
    collectScalars(nested, names, result);
  }
}

function messageScalars(message: ParsedAlertMessage, names: string[]): string[] {
  if (message.format === 'json') {
    const result: string[] = [];
    collectScalars(message.value, new Set(names.map((name) => name.toLowerCase())), result);
    return result;
  }
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const pattern = new RegExp(`<(?:[\\w.-]+:)?(?:${escaped})\\b[^>]*>([^<]*)<`, 'gi');
  return [...message.body.matchAll(pattern)].map((match) => match[1].trim());
}

export function isRelevantAccessEvent(message: ParsedAlertMessage): boolean {
  const eventTypes = messageScalars(message, ['eventType', 'eventTypeString', 'type']);
  if (eventTypes.some((value) => /heartbeat|keepalive/i.test(value))) return false;

  const identity = messageScalars(message, [
    'employeeNoString', 'employeeNo', 'cardNo', 'verifyNo', 'attendanceStatus',
  ]);
  if (identity.some((value) => value.length > 0)) return true;
  if (eventTypes.some((value) =>
    /access(?:controller|control)|acsEvent|face(?:Authentication|Recognition)|fingerprint/i.test(value))) {
    return true;
  }

  const majors = messageScalars(message, ['major', 'majorEventType']);
  const minors = messageScalars(message, ['minor', 'subEventType', 'minorEventType']);
  const numericMajors = majors.map(Number).filter(Number.isFinite);
  if (numericMajors.length > 0 && !numericMajors.includes(5)) return false;
  if (numericMajors.includes(5)) return true;
  if (majors.length === 0 && minors.some((value) => Number(value) === 38)) return true;
  return false;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'Connection aborted.';
  const details = getErrorDetails(error);
  return details.code ? `${details.message} (${String(details.code)})` : details.message;
}

export class HikvisionAlertStream {
  private readonly host: string | undefined;
  private readonly username: string | undefined;
  private readonly password: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly debounceMs: number;
  private readonly reconnectDelaysMs: number[];
  private readonly connectionTimeoutMs: number;
  private status: RealtimeListenerStatus = {
    listenerState: 'stopped',
    lastRealtimeEvent: null,
    reconnectAttempt: 0,
    lastListenerError: null,
  };
  private started = false;
  private unsupported = false;
  private generation = 0;
  private controller: AbortController | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectWake: (() => void) | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private consecutiveAuth401 = 0;
  private readonly removeAuthListener: () => void;
  private readonly removeResumeListener: () => void;

  constructor(private readonly options: AlertStreamOptions) {
    this.host = options.host ?? process.env.HIKVISION_HOST;
    this.username = options.username ?? process.env.HIKVISION_USER;
    this.password = options.password ?? process.env.HIKVISION_PASS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.debounceMs = options.debounceMs ?? 1_000;
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? 8_000;
    this.removeAuthListener = onHikvisionAuthenticationHalted((reason) => {
      this.started = false;
      this.cancelPendingWork();
      this.updateStatus({
        listenerState: 'authentication_halted',
        reconnectAttempt: 0,
        lastListenerError: reason,
      });
    });
    this.removeResumeListener = onHikvisionAuthenticationResumed(() => {
      this.consecutiveAuth401 = 0;
      this.start();
    });
  }

  get currentStatus(): RealtimeListenerStatus {
    return { ...this.status };
  }

  start(): void {
    if (this.started || this.unsupported || isHikvisionAuthenticationHalted()) return;
    this.validateConfig();
    this.started = true;
    const generation = ++this.generation;
    this.updateStatus({ listenerState: 'reconnecting', reconnectAttempt: 0 });
    void this.connectLoop(generation);
  }

  stop(): void {
    this.started = false;
    this.generation += 1;
    this.cancelPendingWork();
    if (!isHikvisionAuthenticationHalted()) {
      this.updateStatus({ listenerState: 'stopped', reconnectAttempt: 0 });
    }
  }

  dispose(): void {
    this.stop();
    this.removeAuthListener();
    this.removeResumeListener();
  }

  private validateConfig(): void {
    const missing = [
      ['HIKVISION_HOST', this.host],
      ['HIKVISION_USER', this.username],
      ['HIKVISION_PASS', this.password],
    ].filter((entry) => !entry[1]).map((entry) => entry[0]);
    if (missing.length > 0) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  private get streamUrl(): string {
    const host = this.host!.replace(/\/+$/, '');
    const baseUrl = /^https?:\/\//i.test(host) ? host : `http://${host}`;
    return new URL(ALERT_STREAM_PATH, `${baseUrl}/`).toString();
  }

  private async connectLoop(generation: number): Promise<void> {
    let failureCount = 0;
    while (this.started && generation === this.generation) {
      let connectedAt = 0;
      try {
        const response = await this.openStream();
        if (!response) return;
        connectedAt = Date.now();
        this.consecutiveAuth401 = 0;
        this.updateStatus({ listenerState: 'connected', reconnectAttempt: 0, lastListenerError: null });
        log('info', 'REALTIME LISTENER CONNECTED');
        await this.readStream(response, generation);
        if (this.started && generation === this.generation) throw new Error('Alert stream ended.');
      } catch (error) {
        if (!this.started || generation !== this.generation) return;
        if (connectedAt > 0 && Date.now() - connectedAt >= STABLE_CONNECTION_MS) failureCount = 0;
        failureCount += 1;
        const reconnectAttempt = Math.min(failureCount, this.reconnectDelaysMs.length);
        const baseDelay = this.reconnectDelaysMs[reconnectAttempt - 1];
        const delayMs = Math.max(1, Math.round(baseDelay * (0.8 + this.random() * 0.4)));
        const message = safeErrorMessage(error);
        this.updateStatus({ listenerState: 'reconnecting', reconnectAttempt, lastListenerError: message });
        log('warn', 'REALTIME LISTENER RECONNECTING', { reconnectAttempt, delayMs, message });
        await this.waitForReconnect(delayMs);
      }
    }
  }

  private async openStream(): Promise<Response | null> {
    const url = this.streamUrl;
    const challengeController = new AbortController();
    this.controller = challengeController;
    const challengeResponse = await this.fetchHeaders(url, {
      method: 'GET',
      headers: { Accept: 'multipart/mixed, application/xml, application/json' },
      signal: challengeController.signal,
    }, challengeController);
    if (challengeResponse.status !== 401) return this.acceptStreamResponse(challengeResponse, false);

    const header = challengeResponse.headers.get('www-authenticate');
    await challengeResponse.body?.cancel().catch(() => undefined);
    if (!header) throw new Error('Device returned 401 without a Digest challenge.');
    const challenge = parseDigestChallenge(header);
    const parsedUrl = new URL(url);
    const authorization = buildDigestAuthorization({
      username: this.username!,
      password: this.password!,
      method: 'GET',
      uri: `${parsedUrl.pathname}${parsedUrl.search}`,
      challenge,
      nonceCount: 1,
      cnonce: randomBytes(16).toString('hex'),
    });
    log('info', 'REALTIME DIGEST CHALLENGE ACCEPTED', {
      algorithm: challenge.algorithm,
      qop: challenge.qop ?? 'legacy',
    });

    const authenticatedController = new AbortController();
    this.controller = authenticatedController;
    const authenticatedResponse = await this.fetchHeaders(url, {
      method: 'GET',
      headers: {
        Accept: 'multipart/mixed, application/xml, application/json',
        Authorization: authorization,
      },
      signal: authenticatedController.signal,
    }, authenticatedController);
    return this.acceptStreamResponse(authenticatedResponse, true);
  }

  private async fetchHeaders(
    url: string,
    init: RequestInit,
    controller: AbortController,
  ): Promise<Response> {
    const timeout = setTimeout(() => controller.abort(), this.connectionTimeoutMs);
    try {
      return await this.fetchImpl(url, init);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async acceptStreamResponse(response: Response, credentialsSent: boolean): Promise<Response | null> {
    if (response.status === 401 && credentialsSent) {
      await response.body?.cancel().catch(() => undefined);
      this.consecutiveAuth401 += 1;
      if (this.consecutiveAuth401 < MAX_CONSECUTIVE_AUTH_401) {
        // Likely a stale device nonce; throw so the backoff loop reconnects with a
        // fresh Digest handshake instead of permanently halting.
        throw new Error(
          `Authenticated alert-stream request returned 401 (attempt ${this.consecutiveAuth401}); retrying with a fresh handshake.`,
        );
      }
      const reason = 'Authenticated alert-stream request was rejected; restart or save configuration to retry.';
      haltHikvisionAuthentication(reason);
      log('error', 'HIKVISION AUTHENTICATION HALTED', {
        source: 'realtime_listener', status: 401, attempts: this.consecutiveAuth401, reason,
      });
      return null;
    }
    if (response.status === 404 || response.status === 405) {
      await response.body?.cancel().catch(() => undefined);
      this.unsupported = true;
      this.started = false;
      const message = `Alert stream is unsupported by this device (HTTP ${response.status}).`;
      this.updateStatus({ listenerState: 'stopped', reconnectAttempt: 0, lastListenerError: message });
      log('warn', 'REALTIME LISTENER DISABLED', { status: response.status, reason: 'unsupported' });
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Alert stream request failed with HTTP ${response.status}.`);
    }
    if (!response.body) throw new Error('Alert stream response had no body.');
    return response;
  }

  private async readStream(response: Response, generation: number): Promise<void> {
    const parser = new IncrementalAlertParser(response.headers.get('content-type') ?? '');
    const reader = response.body!.getReader();
    try {
      while (this.started && generation === this.generation) {
        const result = await reader.read();
        if (result.done) return;
        for (const message of parser.push(result.value)) {
          if (isRelevantAccessEvent(message)) this.handleRelevantEvent();
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private handleRelevantEvent(): void {
    const receivedAt = this.now().toISOString();
    this.updateStatus({ lastRealtimeEvent: receivedAt });
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (!this.started) return;
      log('info', 'BIOMETRIC TRIGGER RECEIVED', { receivedAt });
      void Promise.resolve(this.options.onTrigger()).catch((error: unknown) => {
        log('error', 'ERROR DETAILS', {
          stage: 'biometric_trigger', message: safeErrorMessage(error),
        });
      });
    }, this.debounceMs);
  }

  private waitForReconnect(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      this.reconnectWake = resolve;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.reconnectWake = null;
        resolve();
      }, delayMs);
    });
  }

  private cancelPendingWork(): void {
    this.controller?.abort();
    this.controller = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectWake?.();
    this.reconnectWake = null;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  private updateStatus(values: Partial<RealtimeListenerStatus>): void {
    this.status = { ...this.status, ...values };
    this.options.onStatusChange?.({ ...this.status });
  }
}
