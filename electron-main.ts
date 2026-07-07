import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, promises as fs, type WriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Tray,
} from 'electron';
import {
  DEFAULT_CONFIG,
  appDirectory,
  applyConfig,
  loadInstalledConfig,
  saveInstalledConfig,
  validateConfig,
  type AgentConfig,
} from './src/config.js';
import { CONFIG_WINDOW_HTML } from './src/window-content.js';
import { LOGO_MARK_DATA_URI } from './src/logo-asset.js';
import { probeHikvision, probeVps } from './src/probe.js';
import {
  HikvisionAlertStream,
  type ListenerState,
} from './src/alert-stream.js';
import {
  isHikvisionAuthenticationHalted,
  onHikvisionAuthenticationHalted,
  resetHikvisionAuthentication,
} from './src/hikvision-auth.js';
import { writeLog as log } from './src/logger.js';
import {
  SingleFlightSyncCoordinator,
  type SyncReason,
} from './src/sync-coordinator.js';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.join(app.getAppPath(), 'preload.cjs');
const logPath = path.join(appDirectory, 'agent.log');
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const REALTIME_WATCHDOG_MS = 60_000;
// Cooldown before auto-clearing an authentication halt and retrying, backing off per
// consecutive halt so a device with genuinely-wrong credentials is not hammered.
const AUTH_RECOVERY_DELAYS_MS = [5, 15, 30, 60].map((minutes) => minutes * 60_000);
// Startup-only guard against a stale oversized log left by a previous session; the log is
// otherwise cleared at the end of each daily sync window (see endDailyWindow).
const MAX_AGENT_LOG_BYTES = 5 * 1024 * 1024;

interface AgentStatus {
  message: string;
  lastRun: string | null;
  running: boolean;
  listenerState: ListenerState;
  lastRealtimeEvent: string | null;
  lastEventTriggeredSync: string | null;
  pendingSync: boolean;
  reconnectAttempt: number;
  lastListenerError: string | null;
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let syncTimer: NodeJS.Timeout | null = null;
let dailyLifecycleTimer: NodeJS.Timeout | null = null;
let realtimeWatchdogTimer: NodeJS.Timeout | null = null;
let authRecoveryTimer: NodeJS.Timeout | null = null;
let authRecoveryAttempt = 0;
let syncInProgress = false;
let currentConfig: AgentConfig | null = null;
let logStream: WriteStream | null = null;
let forceQuit = false;
let status: AgentStatus = {
  message: 'Configuration required.',
  lastRun: null,
  running: false,
  listenerState: 'stopped',
  lastRealtimeEvent: null,
  lastEventTriggeredSync: null,
  pendingSync: false,
  reconnectAttempt: 0,
  lastListenerError: null,
};
let syncModule: Promise<typeof import('./src/sync.js')> | null = null;
let alertStream: HikvisionAlertStream | null = null;

async function enforceLogSizeLimit(): Promise<number> {
  try {
    const { size } = await fs.stat(logPath);
    if (size <= MAX_AGENT_LOG_BYTES) return 0;
    await fs.truncate(logPath, 0);
    return size;
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;
    if (code === 'ENOENT') return 0;
    throw error;
  }
}

async function clearLogFile(reason: string): Promise<void> {
  try {
    await fs.mkdir(appDirectory, { recursive: true });
    await fs.truncate(logPath, 0).catch(async () => fs.writeFile(logPath, ''));
    log('info', 'LOGS CLEARED', { reason });
  } catch (error) {
    log('error', 'ERROR DETAILS', {
      stage: 'log_clear',
      reason,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function enableFileLogging(): Promise<void> {
  mkdirSync(appDirectory, { recursive: true });
  const clearedBytes = await enforceLogSizeLimit();
  logStream = createWriteStream(logPath, { flags: 'a' });
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...values: unknown[]): void => {
      if (!app.isPackaged) original(...values);
      logStream?.write(`${values.map((value) =>
        typeof value === 'string' ? value : JSON.stringify(value)).join(' ')}\n`);
    };
  }
  if (clearedBytes > 0) {
    log('warn', 'LOG SIZE LIMIT APPLIED', {
      clearedBytes,
      maxBytes: MAX_AGENT_LOG_BYTES,
    });
  }
}

function appIcon() {
  return nativeImage.createFromDataURL(LOGO_MARK_DATA_URI);
}

function trayIcon() {
  return appIcon().resize({ width: 16, height: 16 });
}

function updateTrayMenu(): void {
  if (!tray) return;
  tray.setToolTip(`Meedo Hikvision Sync Agent — ${status.message}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: status.message, enabled: false },
    { type: 'separator' },
    { label: 'Open settings', click: () => showWindow() },
    { label: 'Sync now', enabled: Boolean(currentConfig) && !syncInProgress, click: () => void requestSync('manual') },
    { label: 'Reconnect now', enabled: Boolean(currentConfig), click: () => reconnectHikvision('manual') },
    { label: 'View logs', click: () => openLogViewer() },
    { type: 'separator' },
    { label: 'Uninstall permanently…', click: () => void launchUninstaller() },
    { label: 'Quit until next login', click: () => { forceQuit = true; app.quit(); } },
  ]));
}

function setStatus(message: string, values: Partial<AgentStatus> = {}): void {
  status = { ...status, ...values, message };
  updateTrayMenu();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status:changed', status);
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 780,
    height: 680,
    minWidth: 620,
    minHeight: 580,
    show: false,
    title: 'Meedo Hikvision Sync Agent',
    icon: appIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  window.webContents.on('preload-error', (_event, preload, error) => {
    log('error', 'PRELOAD FAILED', { preload, message: error.message, stack: error.stack });
  });
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error' || details.level === 'warning') {
      log(details.level === 'error' ? 'error' : 'warn', 'RENDERER MESSAGE', {
        message: details.message,
        lineNumber: details.lineNumber,
        sourceId: details.sourceId,
      });
    }
  });
  window.on('close', (event) => {
    if (!forceQuit) {
      event.preventDefault();
      window.hide();
    }
  });
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(CONFIG_WINDOW_HTML)}`);
  return window;
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
  mainWindow.show();
  mainWindow.focus();
}

function configureAutoStart(enabled: boolean): void {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
    args: enabled ? ['--hidden'] : [],
  });
}

function environmentDefaults(): AgentConfig {
  return {
    ...DEFAULT_CONFIG,
    HIKVISION_HOST: process.env.HIKVISION_HOST ?? DEFAULT_CONFIG.HIKVISION_HOST,
    HIKVISION_USER: process.env.HIKVISION_USER ?? DEFAULT_CONFIG.HIKVISION_USER,
    HIKVISION_PASS: process.env.HIKVISION_PASS ?? DEFAULT_CONFIG.HIKVISION_PASS,
    VPS_URL: process.env.VPS_URL ?? DEFAULT_CONFIG.VPS_URL,
    SYNC_INTERVAL_MINUTES: Number(process.env.SYNC_INTERVAL_MINUTES) || DEFAULT_CONFIG.SYNC_INTERVAL_MINUTES,
    SYNC_START_TIME: process.env.SYNC_START_TIME ?? DEFAULT_CONFIG.SYNC_START_TIME,
    SYNC_END_TIME: process.env.SYNC_END_TIME ?? DEFAULT_CONFIG.SYNC_END_TIME,
    REALTIME_ENABLED: process.env.REALTIME_ENABLED === undefined
      ? DEFAULT_CONFIG.REALTIME_ENABLED
      : !['false', '0', 'off', 'no'].includes(process.env.REALTIME_ENABLED.toLowerCase()),
  };
}

function configuredWindow(now: Date, config: AgentConfig): { start: Date; end: Date } {
  const local = new Date(now.getTime() + MANILA_OFFSET_MS);
  const instant = (time: string): Date => {
    const [hour, minute] = time.split(':').map(Number);
    return new Date(Date.UTC(
      local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute,
    ) - MANILA_OFFSET_MS);
  };
  return { start: instant(config.SYNC_START_TIME), end: instant(config.SYNC_END_TIME) };
}

function scheduleNextIntervalSync(): void {
  if (syncTimer) clearTimeout(syncTimer);
  if (!currentConfig || forceQuit) return;
  const now = new Date();
  const window = configuredWindow(now, currentConfig);
  const intervalMs = currentConfig.SYNC_INTERVAL_MINUTES * 60_000;
  let nextRun: Date;
  if (now < window.start) {
    nextRun = new Date(window.start.getTime() + intervalMs);
  } else if (now >= window.end) {
    nextRun = new Date(window.start.getTime() + DAY_MS + intervalMs);
  } else {
    nextRun = new Date(now.getTime() + intervalMs);
    if (nextRun >= window.end) nextRun = new Date(window.start.getTime() + DAY_MS + intervalMs);
  }
  syncTimer = setTimeout(() => {
    scheduleNextIntervalSync();
    void requestSync('scheduled');
  }, Math.max(1_000, nextRun.getTime() - now.getTime()));
}

async function executeSyncCycle(reason: SyncReason): Promise<void> {
  if (!currentConfig) return;
  try {
    const module = await (syncModule ??= import('./src/sync.js'));
    const now = new Date();
    const dailyWindow = module.dailySyncWindow(now);
    if (!module.syncAllowedAt(reason, now, dailyWindow)) {
      setStatus(
        `Paused — daily window is ${currentConfig.SYNC_START_TIME}–${currentConfig.SYNC_END_TIME} Asia/Manila.`,
        { running: false },
      );
      return;
    }

    setStatus('Synchronizing…', { running: true });
    await module.default(reason);
    // A sync that finished without the auth being (re)halted proves credentials work,
    // so clear the recovery backoff. Guarded because a halted sync completes trivially.
    if (!isHikvisionAuthenticationHalted()) authRecoveryAttempt = 0;
    const completedAt = new Date().toISOString();
    setStatus('Running in system tray.', {
      running: false,
      lastRun: completedAt,
      lastEventTriggeredSync: reason === 'biometric_trigger'
        ? completedAt
        : status.lastEventTriggeredSync,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('error', 'SYNC CYCLE FAILED', { source: reason, message });
    setStatus(`Sync failed: ${message}`, { running: false, lastRun: new Date().toISOString() });
  }
}

const syncCoordinator = new SingleFlightSyncCoordinator(executeSyncCycle, (coordinatorStatus) => {
  syncInProgress = coordinatorStatus.running;
  setStatus(status.message, {
    running: coordinatorStatus.running,
    pendingSync: coordinatorStatus.pending,
  });
});

function requestSync(reason: SyncReason): Promise<void> {
  return syncCoordinator.request(reason);
}

function stopRealtimeWatchdog(): void {
  if (realtimeWatchdogTimer) clearInterval(realtimeWatchdogTimer);
  realtimeWatchdogTimer = null;
}

function startRealtimeWatchdog(): void {
  if (realtimeWatchdogTimer || forceQuit || !currentConfig?.REALTIME_ENABLED) return;
  realtimeWatchdogTimer = setInterval(() => {
    void requestSync('watchdog');
  }, REALTIME_WATCHDOG_MS);
  log('info', 'REALTIME WATCHDOG STARTED', { intervalMs: REALTIME_WATCHDOG_MS });
}

function cancelAuthRecovery(): void {
  if (authRecoveryTimer) clearTimeout(authRecoveryTimer);
  authRecoveryTimer = null;
}

function scheduleAuthRecovery(): void {
  if (authRecoveryTimer || forceQuit || !currentConfig) return;
  const index = Math.min(authRecoveryAttempt, AUTH_RECOVERY_DELAYS_MS.length - 1);
  const delayMs = AUTH_RECOVERY_DELAYS_MS[index];
  authRecoveryAttempt += 1;
  log('warn', 'HIKVISION AUTH RECOVERY SCHEDULED', { delayMs, attempt: authRecoveryAttempt });
  authRecoveryTimer = setTimeout(() => {
    authRecoveryTimer = null;
    reconnectHikvision('auto');
  }, delayMs);
}

/** Clears an authentication halt and restarts the listener + a catch-up sync. */
function reconnectHikvision(reason: 'auto' | 'manual'): void {
  if (forceQuit || !currentConfig) return;
  cancelAuthRecovery();
  log('info', 'HIKVISION RECONNECT REQUESTED', { reason });
  // Clearing the halt fires the stream's resume listener, which restarts it; the extra
  // start() call is a no-op if that already happened, and covers the realtime-disabled case.
  resetHikvisionAuthentication();
  alertStream?.start();
  void requestSync('manual');
}

function scheduleDailyLifecycle(): void {
  if (dailyLifecycleTimer) clearTimeout(dailyLifecycleTimer);
  if (!currentConfig || forceQuit) return;
  const now = new Date();
  const window = configuredWindow(now, currentConfig);
  if (now >= window.start && now < window.end) {
    dailyLifecycleTimer = setTimeout(() => {
      void endDailyWindow();
    }, Math.max(1_000, window.end.getTime() - now.getTime()));
    return;
  }

  const nextStart = now < window.start
    ? window.start
    : new Date(window.start.getTime() + DAY_MS);
  dailyLifecycleTimer = setTimeout(() => {
    void enterDailyWindow();
  }, Math.max(1_000, nextStart.getTime() - now.getTime()));
}

async function enterDailyWindow(): Promise<void> {
  await requestSync('morning_catch_up');
  if (!currentConfig || forceQuit) return;
  scheduleDailyLifecycle();
}

/** Fires at the end of the daily sync window: clear the day's logs, then reschedule. */
async function endDailyWindow(): Promise<void> {
  await clearLogFile('daily_window_end');
  if (!currentConfig || forceQuit) return;
  scheduleDailyLifecycle();
}

function initializeAlertStream(): void {
  if (!currentConfig || !currentConfig.REALTIME_ENABLED) {
    setStatus(status.message, { listenerState: 'stopped' });
    return;
  }
  alertStream = new HikvisionAlertStream({
    host: currentConfig.HIKVISION_HOST,
    username: currentConfig.HIKVISION_USER,
    password: currentConfig.HIKVISION_PASS,
    onTrigger: () => {
      setStatus(status.message, { lastEventTriggeredSync: new Date().toISOString() });
      return requestSync('biometric_trigger');
    },
    onStatusChange: (listenerStatus) => {
      if (listenerStatus.listenerState === 'connected') {
        authRecoveryAttempt = 0;
        cancelAuthRecovery();
        startRealtimeWatchdog();
      } else {
        stopRealtimeWatchdog();
      }
      setStatus(status.message, listenerStatus);
    },
  });
}

async function readRecentLogs(): Promise<unknown[]> {
  await fs.mkdir(appDirectory, { recursive: true });
  await fs.appendFile(logPath, '');
  const handle = await fs.open(logPath, 'r');
  try {
    const { size } = await handle.stat();
    const maxBytes = 1_000_000;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split(/\r?\n/);
    if (start > 0) lines.shift();
    return lines
      .filter((line) => line.trim().length > 0)
      .slice(-1_000)
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          const match = line.match(/^(\S+) \[(INFO|WARN|ERROR)] (.*?)(?: — (.*))?$/);
          return match
            ? {
                timestamp: match[1],
                level: match[2].toLowerCase(),
                event: match[3],
                message: match[4] ?? '',
              }
            : { timestamp: null, level: 'info', event: 'Log message', message: line };
        }
      })
      .reverse();
  } finally {
    await handle.close();
  }
}

function openLogViewer(): void {
  showWindow();
  if (!mainWindow) return;
  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', () => mainWindow?.webContents.send('logs:open-viewer'));
  } else {
    mainWindow.webContents.send('logs:open-viewer');
  }
}

async function findUninstaller(): Promise<string | null> {
  if (!app.isPackaged) return null;
  const installationDirectory = path.dirname(process.execPath);
  const files = await fs.readdir(installationDirectory);
  const filename = files.find((file) => /^Uninstall .*\.exe$/i.test(file));
  return filename ? path.join(installationDirectory, filename) : null;
}

async function launchUninstaller(): Promise<{ ok: boolean; message: string } | null> {
  const confirmation = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Cancel', 'Uninstall permanently'],
    defaultId: 0,
    cancelId: 0,
    title: 'Uninstall Meedo Hikvision Sync Agent',
    message: 'Remove the sync agent, auto-start entry, configuration, state, and logs?',
  });
  if (confirmation.response !== 1) return { ok: false, message: 'Uninstall cancelled.' };

  const uninstaller = await findUninstaller();
  if (!uninstaller) {
    return { ok: false, message: 'The Windows uninstaller was not found. Use Settings > Apps.' };
  }
  configureAutoStart(false);
  const child = spawn(uninstaller, [], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  forceQuit = true;
  setTimeout(() => app.quit(), 250);
  return null;
}

function registerIpcHandlers(): void {
  ipcMain.handle('config:get', () => currentConfig ?? environmentDefaults());
  ipcMain.handle('status:get', () => status);
  ipcMain.handle('window:hide', () => mainWindow?.hide());
  ipcMain.handle('logs:get', () => readRecentLogs());
  ipcMain.handle('logs:copy', (_event, text: unknown) => {
    clipboard.writeText(typeof text === 'string' ? text : '');
  });
  ipcMain.handle('logs:clear', async () => {
    await clearLogFile('manual');
    return { ok: true };
  });
  ipcMain.handle('sync:now', async () => {
    if (!currentConfig) return { ok: false, message: 'Save configuration first.' };
    const now = new Date();
    const window = configuredWindow(now, currentConfig);
    if (now < window.start || now >= window.end) {
      return { ok: false, message: 'Outside the configured daily window. No sync request was sent.' };
    }
    await requestSync('manual');
    return { ok: true, message: 'Sync cycle completed.' };
  });
  ipcMain.handle('config:save', async (_event, value: unknown) => {
    try {
      const config = validateConfig(value);
      await saveInstalledConfig(config);
      configureAutoStart(true);
      setStatus('Configuration saved. Restarting…');
      setTimeout(() => {
        app.relaunch();
        forceQuit = true;
        app.exit(0);
      }, 500);
      return { ok: true, message: 'Configuration saved. The tray agent is restarting.' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle('test:connection', async (_event, value: unknown) => {
    const config = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    const [hikvision, vps] = await Promise.all([
      probeHikvision(String(config.HIKVISION_HOST ?? ''), String(config.HIKVISION_USER ?? ''), String(config.HIKVISION_PASS ?? '')),
      probeVps(String(config.VPS_URL ?? '')),
    ]);
    return { hikvision, vps };
  });
  ipcMain.handle('listener:reconnect', () => {
    if (!currentConfig) return { ok: false, message: 'Save configuration first.' };
    reconnectHikvision('manual');
    return { ok: true, message: 'Reconnecting to the device…' };
  });
  ipcMain.handle('app:uninstall', () => launchUninstaller());
}

async function initialize(): Promise<void> {
  dotenv.config({ path: path.join(app.getAppPath(), '.env'), quiet: true });
  await enableFileLogging();
  app.setAppUserModelId('com.geoplan.meedo.hikvision-sync-agent');
  registerIpcHandlers();
  // Auto-recover from any authentication halt (sync client or realtime listener) after a
  // backing-off cooldown, so the agent heals itself without a manual restart.
  onHikvisionAuthenticationHalted(() => scheduleAuthRecovery());

  tray = new Tray(trayIcon());
  tray.on('double-click', () => showWindow());
  updateTrayMenu();

  if (process.argv.includes('--smoke-test')) {
    mainWindow = createWindow();
    mainWindow.webContents.once('did-finish-load', () => {
      log('info', 'GUI SMOKE TEST PASSED');
      setTimeout(() => {
        forceQuit = true;
        app.quit();
      }, 250);
    });
    return;
  }

  try {
    currentConfig = await loadInstalledConfig();
  } catch (error) {
    log('error', 'CONFIGURATION LOAD FAILED', {
      message: error instanceof Error ? error.message : String(error),
    });
    currentConfig = null;
  }

  if (currentConfig) {
    applyConfig(currentConfig);
    configureAutoStart(true);
    setStatus('Running in system tray.');
    initializeAlertStream();
    const now = new Date();
    const window = configuredWindow(now, currentConfig);
    if (now >= window.start && now < window.end) {
      await enterDailyWindow();
      alertStream?.start();
    } else {
      alertStream?.start();
      scheduleDailyLifecycle();
    }
    scheduleNextIntervalSync();
  } else {
    setStatus('Configuration required.');
  }

  if (!process.argv.includes('--hidden') || !currentConfig) showWindow();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.on('window-all-closed', () => undefined);
  app.on('before-quit', () => {
    forceQuit = true;
    if (syncTimer) clearTimeout(syncTimer);
    if (dailyLifecycleTimer) clearTimeout(dailyLifecycleTimer);
    stopRealtimeWatchdog();
    cancelAuthRecovery();
    alertStream?.dispose();
    logStream?.end();
  });
  void app.whenReady().then(initialize).catch((error: unknown) => {
    void dialog.showErrorBox(
      'Meedo Hikvision Sync Agent',
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
  });
}
