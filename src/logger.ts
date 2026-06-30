export type LogLevel = 'info' | 'warn' | 'error';
export type LogDetails = Record<string, unknown>;

const EVENT_NAMES: Record<string, string> = {
  'REQUEST URL': 'Requesting Hikvision events',
  'RESPONSE PREVIEW': 'Hikvision response received',
  'HIKVISION RESPONSE RECEIVED': 'Hikvision response received',
  'DIGEST SESSION STARTED': 'Authentication session started',
  'DIGEST SESSION RENEWED': 'Authentication session renewed safely',
  'DIGEST CHALLENGE ACCEPTED': 'Digest authentication challenge accepted',
  'REGISTERED BIOMETRIC IDS': 'Registered biometric IDs loaded',
  'EVENTS FOUND': 'Attendance events scanned',
  'SYNC SUCCESS COUNT': 'Sync cycle completed',
  'SYNC CYCLE STARTED': 'Sync cycle started',
  'SYNC WINDOW NOT OPEN': 'Sync paused before daily start',
  'SYNC WINDOW CLOSED': 'Sync paused after daily end',
  'HIKVISION AUTHENTICATION HALTED': 'Hikvision authentication stopped for safety',
  'REALTIME LISTENER CONNECTED': 'Real-time listener connected',
  'REALTIME LISTENER RECONNECTING': 'Real-time listener reconnecting',
  'REALTIME LISTENER DISABLED': 'Real-time listener disabled',
  'REALTIME DIGEST CHALLENGE ACCEPTED': 'Real-time authentication challenge accepted',
  'BIOMETRIC TRIGGER RECEIVED': 'Biometric trigger received',
  'REALTIME WATCHDOG STARTED': 'Real-time recovery watchdog started',
  'VPS BATCH RESULT': 'VPS biometric batch processed',
  'ERROR DETAILS': 'Operation failed',
};

function readableName(value: string): string {
  const spaced = value
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : value;
}

function readableValue(value: unknown): string {
  if (value == null) return String(value);
  if (value instanceof Error) return value.message;
  if (Array.isArray(value)) return value.map(readableValue).join(', ');
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, nested]) => `${readableName(key)}: ${readableValue(nested)}`)
      .join(', ');
  }
  return String(value).replace(/\s+/g, ' ').trim();
}

export function eventName(event: string): string {
  return EVENT_NAMES[event] ?? readableName(event);
}

export function writeLog(level: LogLevel, event: string, details: LogDetails = {}): void {
  const detailText = Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${readableName(key)}: ${readableValue(value)}`)
    .join('; ');
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${eventName(event)}` +
    (detailText ? ` — ${detailText}` : '');
  const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  method(line);
}
