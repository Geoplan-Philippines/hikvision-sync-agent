import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, promises as fs, type WriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
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

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.join(moduleDirectory, 'preload.js');
const logPath = path.join(appDirectory, 'agent.log');

interface AgentStatus {
  message: string;
  lastRun: string | null;
  running: boolean;
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let syncTimer: NodeJS.Timeout | null = null;
let syncInProgress = false;
let currentConfig: AgentConfig | null = null;
let logStream: WriteStream | null = null;
let forceQuit = false;
let status: AgentStatus = { message: 'Configuration required.', lastRun: null, running: false };
let syncModule: Promise<typeof import('./src/sync.js')> | null = null;

function log(level: 'info' | 'warn' | 'error', event: string, details: Record<string, unknown> = {}): void {
  const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  method(JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...details }));
}

function enableFileLogging(): void {
  mkdirSync(appDirectory, { recursive: true });
  logStream = createWriteStream(logPath, { flags: 'a' });
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...values: unknown[]): void => {
      if (!app.isPackaged) original(...values);
      logStream?.write(`${values.map((value) =>
        typeof value === 'string' ? value : JSON.stringify(value)).join(' ')}\n`);
    };
  }
}

function trayIcon() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
    '<rect width="32" height="32" rx="8" fill="#1769d2"/><path d="M8 22V10h4l4 6 4-6h4v12h-4v-6l-4 6-4-6v6z" fill="white"/></svg>';
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
    .resize({ width: 16, height: 16 });
}

function updateTrayMenu(): void {
  if (!tray) return;
  tray.setToolTip(`Meedo Hikvision Sync Agent — ${status.message}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: status.message, enabled: false },
    { type: 'separator' },
    { label: 'Open settings', click: () => showWindow() },
    { label: 'Sync now', enabled: Boolean(currentConfig) && !syncInProgress, click: () => void runSyncCycle() },
    { label: 'Open logs', click: () => void openLogs() },
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
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
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
  };
}

function scheduleNextSync(): void {
  if (syncTimer) clearTimeout(syncTimer);
  if (!currentConfig || forceQuit) return;
  syncTimer = setTimeout(() => void runSyncCycle(), currentConfig.SYNC_INTERVAL_MINUTES * 60_000);
}

async function runSyncCycle(): Promise<void> {
  if (!currentConfig || syncInProgress) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncInProgress = true;
  setStatus('Synchronizing…', { running: true });
  try {
    const module = await (syncModule ??= import('./src/sync.js'));
    await module.default();
    setStatus('Running in system tray.', { running: false, lastRun: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('error', 'SYNC CYCLE FAILED', { message });
    setStatus(`Sync failed: ${message}`, { running: false, lastRun: new Date().toISOString() });
  } finally {
    syncInProgress = false;
    scheduleNextSync();
  }
}

async function openLogs(): Promise<void> {
  await fs.mkdir(appDirectory, { recursive: true });
  await fs.appendFile(logPath, '');
  const error = await shell.openPath(logPath);
  if (error) await dialog.showMessageBox({ type: 'error', message: 'Unable to open logs.', detail: error });
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
  ipcMain.handle('logs:open', () => openLogs());
  ipcMain.handle('sync:now', async () => {
    if (!currentConfig) return { ok: false, message: 'Save configuration first.' };
    if (syncInProgress) return { ok: false, message: 'A sync cycle is already running.' };
    await runSyncCycle();
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
  ipcMain.handle('app:uninstall', () => launchUninstaller());
}

async function initialize(): Promise<void> {
  dotenv.config({ path: path.join(app.getAppPath(), '.env'), quiet: true });
  enableFileLogging();
  app.setAppUserModelId('com.geoplan.meedo.hikvision-sync-agent');
  registerIpcHandlers();

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
    void runSyncCycle();
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
