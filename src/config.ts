import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface AgentConfig {
  HIKVISION_HOST: string;
  HIKVISION_USER: string;
  HIKVISION_PASS: string;
  VPS_URL: string;
  SYNC_INTERVAL_MINUTES: number;
  SYNC_START_TIME: string;
  SYNC_END_TIME: string;
}

export const DEFAULT_CONFIG: AgentConfig = {
  HIKVISION_HOST: '10.10.0.52',
  HIKVISION_USER: 'admin',
  HIKVISION_PASS: '',
  VPS_URL: 'https://meedo-v3-api-stg.geoplanph.com/api/v1/',
  SYNC_INTERVAL_MINUTES: 30,
  SYNC_START_TIME: '09:00',
  SYNC_END_TIME: '20:00',
};

export const appDirectory = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
  'Meedo',
  'HikvisionSyncAgent',
);
export const configPath = path.join(appDirectory, 'config.json');
export const statePath = path.join(appDirectory, 'sync-state.json');
export const lockPath = path.join(appDirectory, 'agent.lock');
export const installedExecutablePath = path.join(appDirectory, 'Meedo-Hikvision-Sync-Agent.exe');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseInterval(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const match = value.match(/\d+(?:\.\d+)?/);
    if (match) return Number(match[0]);
  }
  return Number.NaN;
}

export function validateConfig(value: unknown): AgentConfig {
  if (!isRecord(value)) throw new Error('Configuration must be an object.');

  const host = String(value.HIKVISION_HOST ?? '').trim();
  const username = String(value.HIKVISION_USER ?? '').trim();
  const password = String(value.HIKVISION_PASS ?? '');
  const vpsUrl = String(value.VPS_URL ?? '').trim();
  const intervalMinutes = parseInterval(value.SYNC_INTERVAL_MINUTES);
  const startTime = String(value.SYNC_START_TIME ?? '').trim();
  const endTime = String(value.SYNC_END_TIME ?? DEFAULT_CONFIG.SYNC_END_TIME).trim();

  if (!host) throw new Error('HIKVISION_HOST is required.');
  if (!username) throw new Error('HIKVISION_USER is required.');
  if (!password) throw new Error('HIKVISION_PASS is required.');
  if (!/^https?:\/\//i.test(vpsUrl)) throw new Error('VPS_URL must start with http:// or https://.');
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1_440) {
    throw new Error('SYNC_INTERVAL_MINUTES must be between 1 and 1440.');
  }
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(startTime)) {
    throw new Error('SYNC_START_TIME must use 24-hour HH:mm format.');
  }
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(endTime)) {
    throw new Error('SYNC_END_TIME must use 24-hour HH:mm format.');
  }
  if (endTime <= startTime) {
    throw new Error('SYNC_END_TIME must be later than SYNC_START_TIME.');
  }

  return {
    HIKVISION_HOST: host,
    HIKVISION_USER: username,
    HIKVISION_PASS: password,
    VPS_URL: vpsUrl,
    SYNC_INTERVAL_MINUTES: intervalMinutes,
    SYNC_START_TIME: startTime,
    SYNC_END_TIME: endTime,
  };
}

export function configFromEnvironment(): AgentConfig {
  const legacyInterval = process.env.SYNC_INTERVAL_MS
    ? Number(process.env.SYNC_INTERVAL_MS) / 60_000
    : undefined;
  return validateConfig({
    HIKVISION_HOST: process.env.HIKVISION_HOST,
    HIKVISION_USER: process.env.HIKVISION_USER,
    HIKVISION_PASS: process.env.HIKVISION_PASS,
    VPS_URL: process.env.VPS_URL,
    SYNC_INTERVAL_MINUTES:
      process.env.SYNC_INTERVAL_MINUTES ?? process.env.SYNC_TIME ?? legacyInterval ?? 30,
    SYNC_START_TIME: process.env.SYNC_START_TIME ?? '09:00',
    SYNC_END_TIME: process.env.SYNC_END_TIME ?? '20:00',
  });
}

export async function loadInstalledConfig(): Promise<AgentConfig | null> {
  try {
    return validateConfig(JSON.parse(await fs.readFile(configPath, 'utf8')) as unknown);
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function saveInstalledConfig(config: AgentConfig): Promise<void> {
  await fs.mkdir(appDirectory, { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(validateConfig(config), null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

export function applyConfig(config: AgentConfig): void {
  process.env.HIKVISION_HOST = config.HIKVISION_HOST;
  process.env.HIKVISION_USER = config.HIKVISION_USER;
  process.env.HIKVISION_PASS = config.HIKVISION_PASS;
  process.env.VPS_URL = config.VPS_URL;
  process.env.SYNC_INTERVAL_MINUTES = String(config.SYNC_INTERVAL_MINUTES);
  process.env.SYNC_START_TIME = config.SYNC_START_TIME;
  process.env.SYNC_END_TIME = config.SYNC_END_TIME;
  process.env.SYNC_STATE_FILE = statePath;
}
