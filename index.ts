import { createWriteStream, promises as fs, type WriteStream } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { isSea } from 'node:sea';
import dotenv from 'dotenv';
import {
  AgentConfig,
  appDirectory,
  applyConfig,
  configFromEnvironment,
  loadInstalledConfig,
  lockPath,
} from './src/config.js';
import { installOrConfigure, printHelp } from './src/installer.js';

let timer: NodeJS.Timeout | null = null;
let stopping = false;
let lockHandle: fs.FileHandle | null = null;
let logStream: WriteStream | null = null;

function log(level: 'info' | 'error', event: string, details: Record<string, unknown> = {}): void {
  const method = level === 'error' ? console.error : console.log;
  method(JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...details }));
}

function enableFileLogging(): void {
  const file = path.join(appDirectory, 'agent.log');
  logStream = createWriteStream(file, { flags: 'a' });
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...values: unknown[]): void => {
      if (process.stdout.isTTY) original(...values);
      logStream?.write(`${values.map((value) =>
        typeof value === 'string' ? value : JSON.stringify(value)).join(' ')}\n`);
    };
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

async function acquireInstanceLock(): Promise<boolean> {
  await fs.mkdir(appDirectory, { recursive: true });
  try {
    lockHandle = await fs.open(lockPath, 'wx');
    await lockHandle.writeFile(String(process.pid));
    return true;
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    const existingPid = Number(await fs.readFile(lockPath, 'utf8').catch(() => '0'));
    if (Number.isInteger(existingPid) && existingPid > 0 && processIsRunning(existingPid)) {
      return false;
    }
    await fs.rm(lockPath, { force: true });
    lockHandle = await fs.open(lockPath, 'wx');
    await lockHandle.writeFile(String(process.pid));
    return true;
  }
}

async function releaseInstanceLock(): Promise<void> {
  await lockHandle?.close().catch(() => undefined);
  lockHandle = null;
  await fs.rm(lockPath, { force: true }).catch(() => undefined);
}

async function runAgent(config: AgentConfig, standalone: boolean): Promise<void> {
  applyConfig(config);
  if (!await acquireInstanceLock()) {
    log('info', 'AGENT ALREADY RUNNING');
    return;
  }
  if (standalone) enableFileLogging();

  const { default: sync } = await import('./src/sync.js');
  const intervalMs = config.SYNC_INTERVAL_MINUTES * 60_000;

  const run = async (): Promise<void> => {
    if (stopping) return;
    await sync();
    if (!stopping) timer = setTimeout(() => void run(), intervalMs);
  };

  log('info', 'HIKVISION SYNC AGENT STARTED', {
    intervalMinutes: config.SYNC_INTERVAL_MINUTES,
    dailyStartTime: config.SYNC_START_TIME,
    dailyEndTime: config.SYNC_END_TIME,
    timezone: 'Asia/Manila',
  });
  void run();
}

async function stop(signal: NodeJS.Signals): Promise<void> {
  stopping = true;
  if (timer) clearTimeout(timer);
  log('info', 'AGENT STOPPED', { signal });
  await releaseInstanceLock();
  logStream?.end();
}

async function main(): Promise<void> {
  const standalone = isSea();
  if (!standalone) dotenv.config({ path: path.resolve('.env'), quiet: true });

  const command = standalone ? process.argv[1] : process.argv[2];
  if (command === '--help' || command === '-h') {
    printHelp();
    return;
  }
  if ((standalone && !command) || command === '--install' || command === '--configure') {
    await installOrConfigure(standalone);
    return;
  }
  if (command && command !== '--run') {
    throw new Error(`Unknown argument: ${command}. Use --help for available commands.`);
  }

  const config = await loadInstalledConfig() ?? configFromEnvironment();
  await runAgent(config, standalone);
}

process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));
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

void main().catch((error: unknown) => {
  log('error', 'STARTUP FAILED', {
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
