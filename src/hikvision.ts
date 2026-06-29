import DigestClient from 'digest-fetch';
import { parseStringPromise } from 'xml2js';

const EVENT_PATH = '/ISAPI/AccessControl/AcsEvent?format=json';
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_REQUESTS_PER_DIGEST_SESSION = 8;

type LogLevel = 'info' | 'warn' | 'error';
type LogDetails = Record<string, unknown>;
type DigestResponse = Awaited<ReturnType<DigestClient['fetch']>>;

export interface AttendanceQuery {
  searchId: string;
  position: number;
  maxResults: number;
  startTime: string;
  endTime: string;
}

export function log(level: LogLevel, event: string, details: LogDetails = {}): void {
  const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  method(JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...details }));
}

export function getErrorDetails(error: unknown): { message: string; code?: unknown } {
  const details: { message: string; code?: unknown } = {
    message: error instanceof Error ? error.message : String(error),
  };
  if (typeof error === 'object' && error !== null && 'code' in error) {
    details.code = error.code;
  }
  return details;
}

export class HikvisionClient {
  private readonly host = process.env.HIKVISION_HOST;
  private readonly username = process.env.HIKVISION_USER;
  private readonly password = process.env.HIKVISION_PASS;
  private readonly timeoutMs = Number(process.env.HIKVISION_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  private client: DigestClient | null = null;
  private authenticationHalted = false;
  private successfulSessionRequests = 0;

  private validateConfig(): void {
    const missing = [
      ['HIKVISION_HOST', this.host],
      ['HIKVISION_USER', this.username],
      ['HIKVISION_PASS', this.password],
    ].filter((entry) => !entry[1]).map((entry) => entry[0]);

    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
  }

  private get baseUrl(): string {
    this.validateConfig();
    const host = this.host!.replace(/\/+$/, '');
    return /^https?:\/\//i.test(host) ? host : `http://${host}`;
  }

  private getClient(): DigestClient {
    if (this.successfulSessionRequests >= MAX_REQUESTS_PER_DIGEST_SESSION) {
      this.client = null;
      this.successfulSessionRequests = 0;
      log('info', 'DIGEST SESSION RENEWED', {
        reason: 'Proactive nonce renewal before device session exhaustion.',
      });
    }
    if (!this.client) {
      this.validateConfig();
      this.client = new DigestClient(this.username!, this.password!);
    }
    return this.client;
  }

  async request(path: string, options: RequestInit = {}): Promise<unknown | null> {
    if (this.authenticationHalted) {
      log('warn', 'HIKVISION AUTHENTICATION HALTED', {
        reason: 'A previous request returned 401; restart the agent to try again.',
      });
      return null;
    }

    let url: string;
    try {
      url = new URL(path, `${this.baseUrl}/`).toString();
    } catch (error) {
      log('error', 'ERROR DETAILS', { stage: 'hikvision_config', ...getErrorDetails(error) });
      return null;
    }

    const method = options.method ?? 'GET';
    log('info', 'REQUEST URL', { method, url });

    let response: DigestResponse;
    try {
      response = await this.fetchWithTimeout(url, options);
      if (response.status === 401) {
        await response.arrayBuffer().catch(() => undefined);
        this.authenticationHalted = true;
        log('error', 'HIKVISION AUTHENTICATION HALTED', {
          method,
          url,
          status: 401,
          reason: 'No retry was attempted to avoid device account lockout. Restart the agent to try again.',
        });
        return null;
      }
    } catch (error) {
      log('error', 'ERROR DETAILS', { stage: 'hikvision_request', url, ...getErrorDetails(error) });
      return null;
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      log('error', 'ERROR DETAILS', { stage: 'hikvision_response_read', url, ...getErrorDetails(error) });
      return null;
    }

    log('info', 'RESPONSE PREVIEW', {
      status: response.status,
      preview: text.slice(0, 300).replace(/\s+/g, ' '),
    });

    if (!response.ok) {
      log('error', 'ERROR DETAILS', {
        stage: 'hikvision_http',
        url,
        status: response.status,
        body: text.slice(0, 300),
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
        return await parseStringPromise(text, {
          explicitArray: false,
          explicitRoot: true,
          trim: true,
        }) as unknown;
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

  private async fetchWithTimeout(url: string, options: RequestInit): Promise<DigestResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.getClient().fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  getAttendanceEvents(query: AttendanceQuery): Promise<unknown | null> {
    return this.request(EVENT_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, application/xml',
      },
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
