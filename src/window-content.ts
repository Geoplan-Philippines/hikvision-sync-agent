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
    .log-overlay { position: fixed; inset: 0; z-index: 20; padding: 22px; background: rgba(17, 24, 39, .48); }
    .log-overlay.hidden { display: none; }
    .log-panel { width: min(1100px, 100%); height: 100%; margin: 0 auto; display: flex; flex-direction: column; overflow: hidden; border-radius: 12px; background: #f8fafc; box-shadow: 0 24px 70px rgba(0, 0, 0, .28); }
    .log-header { display: flex; align-items: center; gap: 10px; padding: 16px 18px; border-bottom: 1px solid #d8deea; background: white; }
    .log-header h2 { margin: 0; font-size: 19px; }
    .log-header .spacer { flex: 1; }
    .log-toolbar { display: grid; grid-template-columns: minmax(180px, 1fr) 130px auto auto auto; gap: 8px; padding: 12px 18px; border-bottom: 1px solid #e1e6ef; }
    .log-toolbar input, .log-toolbar select { height: 36px; border: 1px solid #cbd3df; border-radius: 7px; padding: 0 9px; background: white; }
    .log-summary { padding: 8px 18px; color: #667085; font-size: 12px; }
    .log-entries { flex: 1; overflow: auto; padding: 0 18px 18px; }
    .log-row { margin-top: 8px; border: 1px solid #d8deea; border-left-width: 5px; border-radius: 8px; background: white; }
    .log-row.info { border-left-color: #3478df; }
    .log-row.warn { border-left-color: #f79009; }
    .log-row.error { border-left-color: #d92d20; }
    .log-title { display: flex; align-items: center; gap: 9px; padding: 10px 12px; }
    .log-time { color: #667085; font-size: 12px; white-space: nowrap; }
    .log-level { min-width: 48px; border-radius: 999px; padding: 2px 7px; text-align: center; font-size: 10px; font-weight: 700; text-transform: uppercase; background: #eaf1fd; color: #175cd3; }
    .warn .log-level { background: #fff3d6; color: #b54708; }
    .error .log-level { background: #fee4e2; color: #b42318; }
    .log-event { font-weight: 650; word-break: break-word; }
    .log-details { margin: 0; padding: 0 12px 11px 125px; color: #475467; font: 12px/1.45 Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
    .log-empty { padding: 40px; text-align: center; color: #667085; }
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
  <div id="log-viewer" class="log-overlay hidden">
    <section class="log-panel">
      <div class="log-header"><h2>Agent logs</h2><div class="spacer"></div><button id="close-logs" type="button">Close</button></div>
      <div class="log-toolbar">
        <input id="log-search" placeholder="Search event or details">
        <select id="log-level"><option value="all">All levels</option><option value="error">Errors</option><option value="warn">Warnings</option><option value="info">Information</option></select>
        <button id="refresh-logs" type="button">Refresh</button>
        <button id="copy-logs" type="button">Copy visible</button>
        <button id="clear-logs" type="button">Clear</button>
      </div>
      <div id="log-summary" class="log-summary"></div>
      <div id="log-entries" class="log-entries"></div>
    </section>
  </div>
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
    if (!api) status.textContent = 'Desktop bridge failed to load. Restart or reinstall the agent.';
    const logViewer = document.getElementById('log-viewer');
    const logEntriesElement = document.getElementById('log-entries');
    let logEntries = [];
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
    function visibleLogs() {
      const level = document.getElementById('log-level').value;
      const search = document.getElementById('log-search').value.trim().toLowerCase();
      return logEntries.filter((entry) => {
        const entryLevel = String(entry.level || 'info').toLowerCase();
        if (level !== 'all' && entryLevel !== level) return false;
        return !search || JSON.stringify(entry).toLowerCase().includes(search);
      });
    }
    function renderLogs() {
      const entries = visibleLogs();
      logEntriesElement.replaceChildren();
      document.getElementById('log-summary').textContent = entries.length + ' of ' + logEntries.length + ' recent entries shown (newest first).';
      if (!entries.length) {
        const empty = document.createElement('div'); empty.className = 'log-empty'; empty.textContent = 'No matching log entries.'; logEntriesElement.appendChild(empty); return;
      }
      const eventNames = {
        'REQUEST URL': 'Requesting Hikvision events',
        'RESPONSE PREVIEW': 'Hikvision response received',
        'DIGEST SESSION STARTED': 'Authentication session started',
        'DIGEST SESSION RENEWED': 'Authentication session renewed safely',
        'DIGEST CHALLENGE ACCEPTED': 'Digest authentication challenge accepted',
        'REGISTERED BIOMETRIC IDS': 'Registered biometric IDs loaded',
        'EVENTS FOUND': 'Attendance events scanned',
        'SYNC SUCCESS COUNT': 'Sync cycle completed',
        'HIKVISION AUTHENTICATION HALTED': 'Hikvision authentication stopped for safety',
        'ERROR DETAILS': 'Operation failed'
      };
      for (const entry of entries) {
        const level = ['error', 'warn'].includes(String(entry.level)) ? String(entry.level) : 'info';
        const row = document.createElement('article'); row.className = 'log-row ' + level;
        const title = document.createElement('div'); title.className = 'log-title';
        const time = document.createElement('span'); time.className = 'log-time';
        time.textContent = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : 'Unknown time';
        const badge = document.createElement('span'); badge.className = 'log-level'; badge.textContent = level;
        const event = document.createElement('span'); event.className = 'log-event';
        const rawEvent = String(entry.event || 'Log message'); event.textContent = eventNames[rawEvent] || rawEvent.replaceAll('_', ' ');
        title.append(time, badge, event); row.appendChild(title);
        const details = Object.fromEntries(Object.entries(entry).filter(([key]) => !['timestamp', 'level', 'event'].includes(key)));
        if (Object.keys(details).length) { const pre = document.createElement('pre'); pre.className = 'log-details'; pre.textContent = JSON.stringify(details, null, 2); row.appendChild(pre); }
        logEntriesElement.appendChild(row);
      }
    }
    async function refreshLogs() { logEntries = await api.getLogs(); renderLogs(); }
    async function openLogViewer() { logViewer.classList.remove('hidden'); await refreshLogs(); }
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
    document.getElementById('logs').addEventListener('click', () => void openLogViewer());
    document.getElementById('hide').addEventListener('click', () => api.hideWindow());
    document.getElementById('uninstall').addEventListener('click', async () => { const result = await api.uninstall(); if (result) showMessage(result.message, !result.ok); });
    document.getElementById('close-logs').addEventListener('click', () => logViewer.classList.add('hidden'));
    document.getElementById('refresh-logs').addEventListener('click', () => void refreshLogs());
    document.getElementById('log-search').addEventListener('input', renderLogs);
    document.getElementById('log-level').addEventListener('change', renderLogs);
    document.getElementById('copy-logs').addEventListener('click', () => {
      const text = visibleLogs().map((entry) => JSON.stringify(entry)).join('\\n'); api.copyLogs(text); showMessage('Visible logs copied.');
    });
    document.getElementById('clear-logs').addEventListener('click', async () => {
      if (!confirm('Clear the local agent log?')) return; await api.clearLogs(); await refreshLogs();
    });
    api.onOpenLogs(() => void openLogViewer());
    setInterval(() => void refreshStatus(), 5000);
    void load().catch((error) => showMessage(String(error), true));
  </script>
</body>
</html>`;
