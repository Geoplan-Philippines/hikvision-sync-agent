import { spawn, spawnSync } from 'node:child_process';
import { promises as fs, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  AgentConfig,
  DEFAULT_CONFIG,
  appDirectory,
  configPath,
  installedExecutablePath,
  loadInstalledConfig,
  saveInstalledConfig,
  validateConfig,
} from './config.js';

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'Meedo Hikvision Sync Agent';
const launcherPath = path.join(appDirectory, 'start-hidden.vbs');
const logPath = path.join(appDirectory, 'agent.log');

function currentDefaults(existing: AgentConfig | null): AgentConfig {
  return {
    HIKVISION_HOST: existing?.HIKVISION_HOST ?? process.env.HIKVISION_HOST ?? DEFAULT_CONFIG.HIKVISION_HOST,
    HIKVISION_USER: existing?.HIKVISION_USER ?? process.env.HIKVISION_USER ?? DEFAULT_CONFIG.HIKVISION_USER,
    HIKVISION_PASS: existing?.HIKVISION_PASS ?? process.env.HIKVISION_PASS ?? DEFAULT_CONFIG.HIKVISION_PASS,
    VPS_URL: existing?.VPS_URL ?? process.env.VPS_URL ?? DEFAULT_CONFIG.VPS_URL,
    SYNC_INTERVAL_MINUTES: existing?.SYNC_INTERVAL_MINUTES ?? DEFAULT_CONFIG.SYNC_INTERVAL_MINUTES,
    SYNC_START_TIME: existing?.SYNC_START_TIME ?? DEFAULT_CONFIG.SYNC_START_TIME,
    SYNC_END_TIME: existing?.SYNC_END_TIME ?? DEFAULT_CONFIG.SYNC_END_TIME,
  };
}

async function ask(
  question: string,
  fallback: string,
  validate: (value: string) => string | null,
): Promise<string> {
  const reader = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const answer = (await reader.question(`${question} [${fallback}]: `)).trim() || fallback;
      const problem = validate(answer);
      if (!problem) return answer;
      console.error(problem);
    }
  } finally {
    reader.close();
  }
}

async function askHidden(question: string, existing: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return ask(question, existing, (value) => value ? null : 'A password is required.');
  }

  stdout.write(existing ? `${question} [Enter keeps current]: ` : `${question}: `);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise<string>((resolve, reject) => {
    let value = '';
    const finish = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      resolve(value || existing);
    };
    const onData = (chunk: string | Buffer): void => {
      for (const character of String(chunk)) {
        if (character === '\u0003') {
          stdin.off('data', onData);
          stdin.setRawMode(false);
          reject(new Error('Installation cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          if (value || existing) finish();
          continue;
        }
        if (character === '\b' || character === '\u007f') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            stdout.write('\b \b');
          }
          continue;
        }
        value += character;
        stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

async function configurationWizard(existing: AgentConfig | null): Promise<AgentConfig> {
  const defaults = currentDefaults(existing);
  console.log('\nMeedo Hikvision Sync Agent Setup');
  console.log('Times use Asia/Manila and 24-hour HH:mm format.\n');

  const host = await ask('Hikvision host', defaults.HIKVISION_HOST, (value) =>
    value ? null : 'Hikvision host is required.');
  const username = await ask('Hikvision username', defaults.HIKVISION_USER, (value) =>
    value ? null : 'Hikvision username is required.');
  const password = await askHidden('Hikvision password', defaults.HIKVISION_PASS);
  const vpsUrl = await ask('VPS API base URL', defaults.VPS_URL, (value) =>
    /^https?:\/\//i.test(value) ? null : 'URL must start with http:// or https://.');
  const interval = await ask(
    'Sync interval in minutes',
    String(defaults.SYNC_INTERVAL_MINUTES),
    (value) => {
      const minutes = Number(value);
      return Number.isInteger(minutes) && minutes >= 1 && minutes <= 1_440
        ? null
        : 'Interval must be a whole number from 1 to 1440.';
    },
  );
  const startTime = await ask('Daily sync start time', defaults.SYNC_START_TIME, (value) =>
    /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? null : 'Time must use HH:mm format.');
  const endTime = await ask('Daily sync end time', defaults.SYNC_END_TIME, (value) => {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return 'Time must use HH:mm format.';
    return value > startTime ? null : 'End time must be later than the start time.';
  });

  return validateConfig({
    HIKVISION_HOST: host,
    HIKVISION_USER: username,
    HIKVISION_PASS: password,
    VPS_URL: vpsUrl,
    SYNC_INTERVAL_MINUTES: Number(interval),
    SYNC_START_TIME: startTime,
    SYNC_END_TIME: endTime,
  });
}

async function secureConfigFile(): Promise<void> {
  const username = process.env.USERDOMAIN && process.env.USERNAME
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : process.env.USERNAME;
  if (!username) return;
  const result = spawnSync('icacls.exe', [configPath, '/inheritance:r', '/grant:r', `${username}:(F)`], {
    windowsHide: true,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.warn('Warning: could not restrict config file permissions.');
  }
}

async function writeHiddenLauncher(): Promise<void> {
  const command = `"${installedExecutablePath}" --run`.replace(/"/g, '""');
  const script = [
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run "${command}", 0, False`,
    '',
  ].join('\r\n');
  await fs.writeFile(launcherPath, script, 'utf8');
}

function registerAutoStart(): void {
  const command = `wscript.exe "${launcherPath}"`;
  const result = spawnSync('reg.exe', [
    'ADD', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', command, '/f',
  ], { windowsHide: true, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Unable to register Windows startup: ${result.stderr || result.stdout}`);
  }
}

function launchInstalledAgent(): void {
  const log = openSync(logPath, 'a');
  const child = spawn(installedExecutablePath, ['--run'], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  closeSync(log);
}

export async function installOrConfigure(isStandaloneExecutable: boolean): Promise<void> {
  const existing = await loadInstalledConfig();
  const config = await configurationWizard(existing);
  await saveInstalledConfig(config);

  if (!isStandaloneExecutable) {
    console.log(`\nConfiguration saved to ${configPath}.`);
    console.log('Build and run the standalone executable to register Windows auto-start.');
    return;
  }

  await fs.mkdir(appDirectory, { recursive: true });
  const source = path.resolve(process.execPath);
  if (source.toLowerCase() !== installedExecutablePath.toLowerCase()) {
    await fs.copyFile(source, installedExecutablePath);
  }
  await writeHiddenLauncher();
  await secureConfigFile();
  registerAutoStart();
  launchInstalledAgent();

  console.log('\nInstallation complete.');
  console.log(`Installed at: ${installedExecutablePath}`);
  console.log(
    `Sync window: ${config.SYNC_START_TIME}-${config.SYNC_END_TIME} Asia/Manila ` +
    '(the active query ends at the current time).',
  );
  console.log(`Polling interval: every ${config.SYNC_INTERVAL_MINUTES} minutes.`);
  console.log('The agent will start automatically after you sign in to Windows.');
}

export function printHelp(): void {
  console.log([
    'Meedo Hikvision Sync Agent',
    '',
    'Double-click the executable to install or update configuration.',
    '  --install     Open setup and register Windows auto-start',
    '  --configure   Update settings and Windows auto-start',
    '  --run         Run the background sync agent',
    '  --help        Show this help',
  ].join('\n'));
}
