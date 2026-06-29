export const CONFIG_WINDOW_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
  <title>Meedo Hikvision Sync Agent</title>
  <style>
    :root { color-scheme: light; font-family: "Segoe UI", Arial, sans-serif; background: #f4f7fb; color: #172033; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 24px; }
    main { max-width: 720px; margin: 0 auto; }
    header { margin-bottom: 18px; }
    h1 { margin: 0 0 5px; font-size: 24px; }
    .subtitle { color: #667085; font-size: 13px; }
    .status { padding: 12px 14px; margin-bottom: 16px; border: 1px solid #ccd7ea; border-radius: 9px; background: #edf4ff; font-size: 13px; }
    form { padding: 20px; border: 1px solid #d8deea; border-radius: 12px; background: white; box-shadow: 0 8px 24px rgba(28, 45, 80, .07); }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }
    .full { grid-column: 1 / -1; }
    label { display: block; font-size: 12px; font-weight: 600; color: #475467; margin-bottom: 6px; }
    input { width: 100%; height: 38px; border: 1px solid #cbd3df; border-radius: 7px; padding: 0 10px; font: inherit; }
    input:focus { outline: 2px solid #a9c8ff; border-color: #3478df; }
    .actions { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 20px; }
    button { border: 1px solid #c4ccda; border-radius: 7px; padding: 9px 14px; background: white; color: #1d2939; font-weight: 600; cursor: pointer; }
    button.primary { border-color: #1769d2; background: #1769d2; color: white; }
    button.danger { margin-left: auto; border-color: #efb3b3; color: #b42318; }
    button:disabled { opacity: .55; cursor: wait; }
    #message { min-height: 20px; margin-top: 12px; font-size: 13px; color: #067647; }
    #message.error { color: #b42318; }
    @media (max-width: 600px) { .grid { grid-template-columns: 1fr; } .full { grid-column: auto; } button.danger { margin-left: 0; } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Meedo Hikvision Sync Agent</h1>
      <div class="subtitle">Runs in the Windows system tray and synchronizes attendance in the background.</div>
    </header>
    <div id="status" class="status">Loading status…</div>
    <form id="config-form">
      <div class="grid">
        <div><label for="host">Hikvision host</label><input id="host" required></div>
        <div><label for="username">Hikvision username</label><input id="username" required></div>
        <div class="full"><label for="password">Hikvision password</label><input id="password" type="password" required autocomplete="new-password"></div>
        <div class="full"><label for="vps">VPS API base URL</label><input id="vps" type="url" required></div>
        <div><label for="interval">Sync interval (minutes)</label><input id="interval" type="number" min="1" max="1440" step="1" required></div>
        <div></div>
        <div><label for="start">Daily start (Asia/Manila)</label><input id="start" type="time" required></div>
        <div><label for="end">Daily end (Asia/Manila)</label><input id="end" type="time" required></div>
      </div>
      <div class="actions">
        <button class="primary" id="save" type="submit">Save and restart</button>
        <button id="sync" type="button">Sync now</button>
        <button id="logs" type="button">Open logs</button>
        <button id="hide" type="button">Hide to tray</button>
        <button class="danger" id="uninstall" type="button">Uninstall permanently</button>
      </div>
      <div id="message"></div>
    </form>
  </main>
  <script>
    const api = window.meedoAgent;
    const fields = {
      host: document.getElementById('host'), username: document.getElementById('username'),
      password: document.getElementById('password'), vps: document.getElementById('vps'),
      interval: document.getElementById('interval'), start: document.getElementById('start'),
      end: document.getElementById('end')
    };
    const message = document.getElementById('message');
    const status = document.getElementById('status');
    function showMessage(text, error) { message.textContent = text; message.className = error ? 'error' : ''; }
    async function refreshStatus() {
      const value = await api.getStatus();
      status.textContent = value.message + (value.lastRun ? ' Last run: ' + new Date(value.lastRun).toLocaleString() + '.' : '');
    }
    async function load() {
      const config = await api.getConfig();
      fields.host.value = config.HIKVISION_HOST || '';
      fields.username.value = config.HIKVISION_USER || '';
      fields.password.value = config.HIKVISION_PASS || '';
      fields.vps.value = config.VPS_URL || '';
      fields.interval.value = config.SYNC_INTERVAL_MINUTES || 30;
      fields.start.value = config.SYNC_START_TIME || '09:00';
      fields.end.value = config.SYNC_END_TIME || '20:00';
      await refreshStatus();
    }
    document.getElementById('config-form').addEventListener('submit', async (event) => {
      event.preventDefault(); showMessage('Saving…');
      const result = await api.saveConfig({
        HIKVISION_HOST: fields.host.value, HIKVISION_USER: fields.username.value,
        HIKVISION_PASS: fields.password.value, VPS_URL: fields.vps.value,
        SYNC_INTERVAL_MINUTES: Number(fields.interval.value),
        SYNC_START_TIME: fields.start.value, SYNC_END_TIME: fields.end.value
      });
      showMessage(result.message, !result.ok);
    });
    document.getElementById('sync').addEventListener('click', async () => { showMessage((await api.syncNow()).message); await refreshStatus(); });
    document.getElementById('logs').addEventListener('click', () => api.openLogs());
    document.getElementById('hide').addEventListener('click', () => api.hideWindow());
    document.getElementById('uninstall').addEventListener('click', async () => { const result = await api.uninstall(); if (result) showMessage(result.message, !result.ok); });
    setInterval(() => void refreshStatus(), 5000);
    void load().catch((error) => showMessage(String(error), true));
  </script>
</body>
</html>`;
