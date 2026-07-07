import { createHash, randomBytes } from 'node:crypto';
import { parseStringPromise } from 'xml2js';
import {
  haltHikvisionAuthentication,
  isHikvisionAuthenticationHalted,
} from './hikvision-auth.js';
import { writeLog as log } from './logger.js';

const EVENT_PATH = '/ISAPI/AccessControl/AcsEvent?format=json';
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_REQUESTS_PER_DIGEST_SESSION = 8;
// Extra authenticated attempts with a fresh Digest handshake before giving up on a 401.
// A 401 after prior success is usually a stale/expired device nonce, not bad credentials.
const AUTH_401_RETRIES = 2;

export interface AttendanceQuery {
  searchId: string;
  position: number;
  maxResults: number;
  startTime: string;
  endTime: string;
}

export interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: 'auth';
  opaque?: string;
  algorithm: 'MD5' | 'MD5-sess';
}

interface DigestAuthorizationInput {
  username: string;
  password: string;
  method: string;
  uri: string;
  challenge: DigestChallenge;
  nonceCount: number;
  cnonce: string;
}

export function getErrorDetails(error: unknown): { message: string; code?: unknown } {
  const details: { message: string; code?: unknown } = {
    message: error instanceof Error ? error.message : String(error),
  };
  if (typeof error === 'object' && error !== null && 'code' in error) details.code = error.code;
  return details;
}

function md5(value: string): string {
  return createHash('md5').update(value).digest('hex');
}

export function parseDigestChallenge(header: string): DigestChallenge {
  if (!/^Digest\s/i.test(header)) throw new Error('Device did not return a Digest challenge.');
  const fields: Record<string, string> = {};
  const pattern = /(\w+)=(?:"([^"]*)"|([^,\s]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(header)) !== null) {
    fields[match[1].toLowerCase()] = match[2] ?? match[3];
  }
  if (!fields.realm || !fields.nonce) throw new Error('Device returned a malformed Digest challenge.');

  const algorithm = (fields.algorithm || 'MD5').toUpperCase();
  if (algorithm !== 'MD5' && algorithm !== 'MD5-SESS') {
    throw new Error(`Unsupported device Digest algorithm: ${algorithm}`);
  }
  const advertisedQop = fields.qop?.split(',').map((value) => value.trim().toLowerCase());
  if (advertisedQop && !advertisedQop.includes('auth')) {
    throw new Error(`Unsupported device Digest qop: ${fields.qop}`);
  }
  return {
    realm: fields.realm,
    nonce: fields.nonce,
    qop: advertisedQop ? 'auth' : undefined,
    opaque: fields.opaque,
    algorithm: algorithm === 'MD5-SESS' ? 'MD5-sess' : 'MD5',
  };
}

export function buildDigestAuthorization(input: DigestAuthorizationInput): string {
  const { username, password, method, uri, challenge, nonceCount, cnonce } = input;
  const nc = nonceCount.toString(16).padStart(8, '0');
  const baseHa1 = md5(`${username}:${challenge.realm}:${password}`);
  const ha1 = challenge.algorithm === 'MD5-sess'
    ? md5(`${baseHa1}:${challenge.nonce}:${cnonce}`)
    : baseHa1;
  const ha2 = md5(`${method.toUpperCase()}:${uri}`);
  const response = challenge.qop
    ? md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${challenge.qop}:${ha2}`)
    : md5(`${ha1}:${challenge.nonce}:${ha2}`);

  const parts = [
    `username="${username}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
    `algorithm=${challenge.algorithm}`,
  ];
  if (challenge.opaque !== undefined) parts.push(`opaque="${challenge.opaque}"`);
  if (challenge.qop) parts.push(`qop=${challenge.qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  return `Digest ${parts.join(', ')}`;
}

export class HikvisionClient {
  private readonly timeoutMs = Number(process.env.HIKVISION_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  private challenge: DigestChallenge | null = null;
  private nonceCount = 0;
  private successfulSessionRequests = 0;

  private get host(): string | undefined {
    return process.env.HIKVISION_HOST;
  }

  private get username(): string | undefined {
    return process.env.HIKVISION_USER;
  }

  private get password(): string | undefined {
    return process.env.HIKVISION_PASS;
  }

  private validateConfig(): void {
    const missing = [
      ['HIKVISION_HOST', this.host],
      ['HIKVISION_USER', this.username],
      ['HIKVISION_PASS', this.password],
    ].filter((entry) => !entry[1]).map((entry) => entry[0]);
    if (missing.length > 0) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  private get baseUrl(): string {
    this.validateConfig();
    const host = this.host!.replace(/\/+$/, '');
    return /^https?:\/\//i.test(host) ? host : `http://${host}`;
  }

  beginEventSearch(): boolean {
    if (isHikvisionAuthenticationHalted()) return false;
    this.resetDigestSession();
    log('info', 'DIGEST SESSION STARTED', {
      reason: 'Nonce counter reset for a new Hikvision event-search cycle.',
    });
    return true;
  }

  private resetDigestSession(): void {
    this.challenge = null;
    this.nonceCount = 0;
    this.successfulSessionRequests = 0;
  }

  private renewSessionIfNeeded(): void {
    if (this.successfulSessionRequests < MAX_REQUESTS_PER_DIGEST_SESSION) return;
    this.resetDigestSession();
    log('info', 'DIGEST SESSION RENEWED', {
      reason: 'Proactive nonce renewal before device session exhaustion.',
    });
  }

  async request(requestPath: string, options: RequestInit = {}): Promise<unknown | null> {
    if (isHikvisionAuthenticationHalted()) {
      log('warn', 'HIKVISION AUTHENTICATION HALTED', {
        reason: 'A previous authenticated request returned 401; restart the agent to try again.',
      });
      return null;
    }

    let url: string;
    try {
      url = new URL(requestPath, `${this.baseUrl}/`).toString();
    } catch (error) {
      log('error', 'ERROR DETAILS', { stage: 'hikvision_config', ...getErrorDetails(error) });
      return null;
    }

    const method = options.method ?? 'GET';
    log('info', 'REQUEST URL', { method, url });

    let response: Response;
    try {
      response = await this.sendAuthenticated(url, options, method);
    } catch (error) {
      log('error', 'ERROR DETAILS', { stage: 'hikvision_request', url, ...getErrorDetails(error) });
      return null;
    }

    if (response.status === 401) {
      await response.arrayBuffer().catch(() => undefined);
      haltHikvisionAuthentication(
        'An authenticated Hikvision request returned 401; restart or save configuration to retry.',
      );
      log('error', 'HIKVISION AUTHENTICATION HALTED', {
        method,
        url,
        status: 401,
        reason: `Authenticated request was still rejected after ${AUTH_401_RETRIES} fresh-handshake retries.`,
      });
      return null;
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      log('error', 'ERROR DETAILS', { stage: 'hikvision_response_read', url, ...getErrorDetails(error) });
      return null;
    }

    log('info', 'HIKVISION RESPONSE RECEIVED', {
      status: response.status,
      contentType: response.headers.get('content-type') ?? 'unknown',
      bytes: Buffer.byteLength(text),
    });
    if (!response.ok) {
      log('error', 'ERROR DETAILS', {
        stage: 'hikvision_http', url, status: response.status,
      });
      return null;
    }
    this.successfulSessionRequests += 1;
    if (!text.trim()) {
      log('warn', 'EMPTY RESPONSE', { url, status: response.status });
      return null;
    }

    try {
      return JSON.parse(text) as unknown;
    } catch (jsonError) {
      try {
        return await parseStringPromise(text, { explicitArray: false, explicitRoot: true, trim: true }) as unknown;
      } catch (xmlError) {
        log('error', 'ERROR DETAILS', {
          stage: 'response_parse',
          jsonError: getErrorDetails(jsonError).message,
          xmlError: getErrorDetails(xmlError).message,
        });
        return null;
      }
    }
  }

  private async sendAuthenticated(url: string, options: RequestInit, method: string): Promise<Response> {
    let response = await this.performRequest(url, options, method);
    // A 401 here means the authenticated request was rejected — usually a stale device
    // nonce after long uptime. Retry with a brand-new challenge before halting, so
    // transient 401s self-heal while genuinely-wrong credentials still stop after a bound.
    for (let retry = 0; response.status === 401 && retry < AUTH_401_RETRIES; retry += 1) {
      await response.arrayBuffer().catch(() => undefined);
      this.resetDigestSession();
      log('info', 'DIGEST SESSION RETRY', {
        attempt: retry + 1,
        reason: 'Authenticated request returned 401; retrying with a fresh Digest handshake.',
      });
      response = await this.performRequest(url, options, method);
    }
    return response;
  }

  private async performRequest(url: string, options: RequestInit, method: string): Promise<Response> {
    this.renewSessionIfNeeded();
    if (this.challenge) return this.authenticatedFetch(url, options, method);
    const challengeResponse = await this.fetchWithTimeout(url, options);
    if (challengeResponse.status !== 401) return challengeResponse;
    const header = challengeResponse.headers.get('www-authenticate');
    await challengeResponse.arrayBuffer().catch(() => undefined);
    if (!header) throw new Error('Device returned 401 without a WWW-Authenticate challenge.');
    this.challenge = parseDigestChallenge(header);
    this.nonceCount = 0;
    log('info', 'DIGEST CHALLENGE ACCEPTED', {
      algorithm: this.challenge.algorithm,
      qop: this.challenge.qop ?? 'legacy',
    });
    return this.authenticatedFetch(url, options, method);
  }

  private authenticatedFetch(url: string, options: RequestInit, method: string): Promise<Response> {
    if (!this.challenge) throw new Error('Digest challenge is not initialized.');
    this.nonceCount += 1;
    const parsedUrl = new URL(url);
    const authorization = buildDigestAuthorization({
      username: this.username!,
      password: this.password!,
      method,
      uri: `${parsedUrl.pathname}${parsedUrl.search}`,
      challenge: this.challenge,
      nonceCount: this.nonceCount,
      cnonce: randomBytes(16).toString('hex'),
    });
    const headers = new Headers(options.headers);
    headers.set('Authorization', authorization);
    return this.fetchWithTimeout(url, { ...options, headers });
  }

  private async fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  getAttendanceEvents(query: AttendanceQuery): Promise<unknown | null> {
    return this.request(EVENT_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, application/xml' },
      body: JSON.stringify({
        AcsEventCond: {
          searchID: query.searchId,
          searchResultPosition: query.position,
          maxResults: query.maxResults,
          major: 5,
          minor: 38,
          startTime: query.startTime,
          endTime: query.endTime,
        },
      }),
    });
  }
}

const hikvision = new HikvisionClient();
export default hikvision;
