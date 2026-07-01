import { randomBytes } from 'node:crypto';
import { buildDigestAuthorization, getErrorDetails, parseDigestChallenge } from './hikvision.js';

// One-shot connection checks used by the setup window's "Test connection".
// Each probe makes at most a single authenticated attempt, so it never trips
// the device's account-lockout protection. It runs independently of the live
// sync client and does not touch its digest session or halt state.

const PROBE_TIMEOUT_MS = 8_000;

export interface ProbeResult {
  ok: boolean;
  message: string;
  detail?: string;
}

async function fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function reachHint(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') {
    return 'The device did not respond in time. Check the IP address and that this PC is on the same network.';
  }
  return 'Check the IP address and that the device is powered on and reachable from this PC.';
}

export async function probeHikvision(hostRaw: string, username: string, password: string): Promise<ProbeResult> {
  const host = String(hostRaw || '').trim().replace(/\/+$/, '');
  if (!host) return { ok: false, message: 'Enter the device host first.' };
  if (!username || !password) return { ok: false, message: 'Enter the device username and password first.' };

  const base = /^https?:\/\//i.test(host) ? host : `http://${host}`;
  let url: string;
  try {
    url = new URL('/ISAPI/System/deviceInfo', `${base}/`).toString();
  } catch {
    return { ok: false, message: 'That host does not look like a valid address.', detail: 'Use an IP address like 192.168.1.64.' };
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(url, { method: 'GET' });
  } catch (error) {
    return { ok: false, message: 'Could not reach the device.', detail: reachHint(error) };
  }

  if (response.status === 401) {
    const header = response.headers.get('www-authenticate');
    await response.arrayBuffer().catch(() => undefined);
    if (!header) return { ok: false, message: 'The device refused authentication.', detail: 'It returned no digest challenge.' };
    let challenge;
    try {
      challenge = parseDigestChallenge(header);
    } catch (error) {
      return { ok: false, message: 'This device uses an unsupported login method.', detail: getErrorDetails(error).message };
    }
    const authorization = buildDigestAuthorization({
      username, password, method: 'GET', uri: new URL(url).pathname,
      challenge, nonceCount: 1, cnonce: randomBytes(16).toString('hex'),
    });
    try {
      response = await fetchWithTimeout(url, { method: 'GET', headers: { Authorization: authorization } });
    } catch (error) {
      return { ok: false, message: 'Could not reach the device.', detail: reachHint(error) };
    }
  }

  if (response.status === 401) {
    await response.arrayBuffer().catch(() => undefined);
    return { ok: false, message: 'Wrong username or password.', detail: 'The device rejected these credentials. Only one attempt was made, to protect the account from lockout.' };
  }
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    return { ok: false, message: `The device responded with an error (HTTP ${response.status}).` };
  }

  let deviceName: string | undefined;
  try {
    const text = await response.text();
    const match = text.match(/<deviceName>([^<]+)<\/deviceName>/i) || text.match(/<model>([^<]+)<\/model>/i);
    if (match) deviceName = match[1].trim();
  } catch {
    // Response body is optional for a reachability check.
  }
  return { ok: true, message: 'Connected to the device.', detail: deviceName ? `Device: ${deviceName}` : undefined };
}

export async function probeVps(urlRaw: string): Promise<ProbeResult> {
  const raw = String(urlRaw || '').trim();
  if (!raw) return { ok: false, message: 'Enter the API URL first.' };
  let target: string;
  try {
    const parsed = new URL(raw);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('protocol');
    target = parsed.toString();
  } catch {
    return { ok: false, message: 'That API URL is not valid.', detail: 'Include https:// at the start, for example https://api.example.com.' };
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(target, { method: 'GET' });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    return {
      ok: false,
      message: 'Could not reach the API.',
      detail: name === 'AbortError' || name === 'TimeoutError'
        ? 'The server did not respond in time.'
        : "Check the URL and this PC's internet connection.",
    };
  }
  return { ok: true, message: 'Reached the API server.', detail: `Server responded (HTTP ${response.status}).` };
}
