import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.basename(moduleDirectory) === 'dist'
  ? path.dirname(moduleDirectory)
  : moduleDirectory;

dotenv.config({ path: path.join(projectDirectory, '.env'), quiet: true });

const { default: sync } = await import('./src/sync.js');

const intervalMs = Math.max(1_000, Number(process.env.SYNC_INTERVAL_MS) || 10_000);
let timer: NodeJS.Timeout | null = null;
let stopping = false;

function log(level: 'info' | 'error', event: string, details: Record<string, unknown> = {}): void {
  const method = level === 'error' ? console.error : console.log;
  method(JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...details }));
}

async function run(): Promise<void> {
  if (stopping) return;
  await sync();
  if (!stopping) timer = setTimeout(() => void run(), intervalMs);
}

function stop(signal: NodeJS.Signals): void {
  stopping = true;
  if (timer) clearTimeout(timer);
  log('info', 'AGENT STOPPED', { signal });
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('unhandledRejection', (error: unknown) => {
  log('error', 'ERROR DETAILS', { stage: 'unhandled_rejection', message: String(error) });
});
process.on('uncaughtException', (error: Error) => {
  log('error', 'ERROR DETAILS', {
    stage: 'uncaught_exception',
    message: error.message,
    stack: error.stack,
  });
});

log('info', 'HIKVISION SYNC AGENT STARTED', { intervalMs });
void run();
