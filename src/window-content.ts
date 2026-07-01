import { LOGO_WORDMARK_DATA_URI } from './logo-asset.js';

export const CONFIG_WINDOW_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
  <title>Meedo Hikvision Sync Agent</title>
  <style>
    :root {
      color-scheme: light;
      /* Meedo v3 "Dispatch Desk" tokens */
      --primary: #0B4EA2;
      --primary-hover: #03285A;
      --primary-foreground: #FFFFFF;
      --secondary: #E8F1FF;
      --secondary-foreground: #0B4EA2;
      --accent: #22D3EE;
      --background: #F8FBFF;
      --surface: #FFFFFF;
      --heading: #0B161F;
      --body: #365261;
      --muted: #5B7383;
      --border: #DBE5F0;
      --success: #3DBE81;
      --success-strong: #127A4E;
      --muted-success: #D1EDE0;
      --destructive: #FF4B4B;
      --destructive-strong: #B42318;
      --muted-destructive: #FFE1DE;
      --warning: #B54708;
      --muted-warning: #FFF3D6;
      --r-base: 4px;
      --r-md: 6px;
      --r-pill: 100px;
      --ease: cubic-bezier(.25, 1, .5, 1);
      --font: "Segoe UI", system-ui, -apple-system, Arial, sans-serif;
      --mono: "Cascadia Code", Consolas, "SFMono-Regular", monospace;
      font-family: var(--font);
      background: var(--background);
      color: var(--body);
    }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 24px; }
    main { max-width: 760px; margin: 0 auto; animation: rise .32s var(--ease) both; }

    /* Header / brand lockup */
    .app-header { display: flex; align-items: center; gap: 12px; }
    .brand { height: 30px; width: auto; display: block; }
    .brand-divider { width: 1px; height: 26px; background: var(--border); }
    .brand-app { display: flex; flex-direction: column; gap: 1px; }
    .brand-app-name { font-size: 15px; font-weight: 700; color: var(--heading); letter-spacing: -.01em; }
    .brand-app-tag { font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--secondary-foreground); }
    .lede { margin: 10px 0 18px; color: var(--body); font-size: 13px; line-height: 1.5; max-width: 68ch; }

    /* Status bar */
    .status-bar { display: flex; align-items: center; gap: 10px; padding: 11px 14px; margin-bottom: 18px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface); font-size: 13px; line-height: 1.45; color: var(--body); }
    .status-dot { position: relative; flex: none; width: 9px; height: 9px; border-radius: 50%; background: var(--secondary-foreground); }
    .status-bar[data-state="ok"] .status-dot { background: var(--success); }
    .status-bar[data-state="warn"] .status-dot { background: var(--warning); }
    .status-bar[data-state="error"] .status-dot { background: var(--destructive); }
    .status-bar[data-state="ok"] .status-dot::after { content: ""; position: absolute; inset: 0; border-radius: 50%; background: inherit; animation: pulse 2.2s var(--ease) infinite; }
    #status { flex: 1; }

    /* Form card */
    form { padding: 22px 22px 20px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface); }
    fieldset { margin: 0 0 22px; padding: 0; border: 0; }
    fieldset:last-of-type { margin-bottom: 0; }
    legend { display: block; width: 100%; padding: 0 0 8px; margin-bottom: 14px; border-bottom: 1px solid var(--border); font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--secondary-foreground); }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .full { grid-column: 1 / -1; }
    label { display: block; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--body); margin-bottom: 6px; }
    .req { color: var(--destructive-strong); margin-left: 2px; text-decoration: none; }
    input { width: 100%; height: 38px; border: 1px solid var(--border); border-radius: var(--r-base); padding: 0 10px; font: inherit; font-size: 13px; color: var(--heading); background: var(--background); transition: border-color .15s var(--ease), box-shadow .15s var(--ease); }
    input::placeholder { color: var(--muted); }
    input:hover { border-color: color-mix(in srgb, var(--primary) 30%, var(--border)); }
    input:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 12%, transparent); }
    .check label { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 13px; font-weight: 500; letter-spacing: normal; text-transform: none; color: var(--body); line-height: 1.4; cursor: pointer; }
    .check input { width: auto; height: auto; accent-color: var(--primary); }

    /* Buttons */
    .actions { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 22px; }
    button { border: 1px solid var(--border); border-radius: var(--r-base); padding: 9px 14px; background: var(--surface); color: var(--body); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; transition: background-color .15s var(--ease), border-color .15s var(--ease), color .15s var(--ease), box-shadow .15s var(--ease), transform .06s var(--ease); }
    button:hover { background: var(--secondary); border-color: var(--primary); color: var(--primary); }
    button:active { transform: translateY(1px); }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    button:disabled { opacity: .55; cursor: default; transform: none; background: var(--surface); border-color: var(--border); color: var(--body); box-shadow: none; }
    button.primary { border-color: var(--primary); background: var(--primary); color: var(--primary-foreground); }
    button.primary:hover { background: var(--primary-hover); border-color: var(--primary-hover); color: var(--primary-foreground); box-shadow: 0 4px 12px color-mix(in srgb, var(--primary) 25%, transparent); }
    button.danger { margin-left: auto; color: var(--destructive-strong); border-color: var(--border); }
    button.danger:hover { background: var(--muted-destructive); border-color: var(--destructive); color: var(--destructive-strong); }
    #message { min-height: 20px; margin-top: 14px; font-size: 13px; font-weight: 500; color: var(--success-strong); }
    #message.error { color: var(--destructive-strong); }

    /* Log viewer */
    .log-overlay { position: fixed; inset: 0; z-index: 100; display: flex; padding: 22px; background: rgba(11, 22, 31, .45); opacity: 0; visibility: hidden; transition: opacity .18s var(--ease), visibility 0s linear .18s; }
    .log-overlay.open { opacity: 1; visibility: visible; transition: opacity .18s var(--ease); }
    .log-panel { width: min(1000px, 100%); height: 100%; margin: 0 auto; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface); box-shadow: 0 24px 70px rgba(11, 22, 31, .28); transform: translateY(10px) scale(.99); transition: transform .22s var(--ease); }
    .log-overlay.open .log-panel { transform: none; }
    .log-header { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--border); }
    .log-header h2 { margin: 0; font-size: 16px; font-weight: 700; color: var(--heading); }
    .log-header .spacer { flex: 1; }
    .log-toolbar { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
    .log-toolbar input, .log-toolbar select { height: 36px; border: 1px solid var(--border); border-radius: var(--r-base); padding: 0 10px; font: inherit; font-size: 13px; color: var(--heading); background: var(--background); transition: border-color .15s var(--ease), box-shadow .15s var(--ease); }
    .log-toolbar input { flex: 1 1 200px; min-width: 160px; }
    .log-toolbar input::placeholder { color: var(--muted); }
    .log-toolbar input:focus, .log-toolbar select:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 12%, transparent); }
    .log-summary { padding: 10px 16px; color: var(--muted); font-size: 12px; border-bottom: 1px solid var(--border); }
    .log-entries { flex: 1; overflow: auto; padding: 4px 16px 16px; }
    .log-entries::-webkit-scrollbar { width: 12px; }
    .log-entries::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--body) 28%, transparent); border-radius: var(--r-pill); border: 3px solid var(--surface); }
    .log-row { margin-top: 8px; border: 1px solid var(--border); border-radius: var(--r-base); background: var(--surface); overflow: hidden; }
    .log-row.warn { background: color-mix(in srgb, var(--muted-warning) 55%, var(--surface)); border-color: color-mix(in srgb, var(--warning) 22%, var(--border)); }
    .log-row.error { background: color-mix(in srgb, var(--muted-destructive) 45%, var(--surface)); border-color: color-mix(in srgb, var(--destructive) 22%, var(--border)); }
    .log-title { display: flex; align-items: center; gap: 10px; padding: 9px 12px; }
    .log-time { flex: none; color: var(--muted); font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .log-level { flex: none; min-width: 52px; border-radius: var(--r-pill); padding: 2px 8px; text-align: center; font-size: 10px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; background: var(--secondary); color: var(--secondary-foreground); }
    .warn .log-level { background: var(--muted-warning); color: var(--warning); }
    .error .log-level { background: var(--muted-destructive); color: var(--destructive-strong); }
    .log-event { flex: 1; font-weight: 600; color: var(--heading); word-break: break-word; }
    .log-fields { margin: 0; padding: 2px 12px 12px; display: grid; gap: 6px; }
    .field { display: grid; grid-template-columns: 150px 1fr; gap: 12px; align-items: baseline; font-size: 12.5px; line-height: 1.5; }
    .field dt { margin: 0; color: var(--muted); font-weight: 600; }
    .field dd { margin: 0; color: var(--body); overflow-wrap: anywhere; }
    .field--block { grid-template-columns: 1fr; gap: 4px; }
    .field--block dd pre { margin: 0; padding: 9px 11px; border: 1px solid var(--border); border-radius: var(--r-base); background: var(--background); color: var(--body); font: 12px/1.55 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 220px; overflow: auto; }
    .log-fields--nested { padding: 2px 0 0; margin-top: 2px; gap: 4px; border-left: 0; }
    .log-fields--nested .field { grid-template-columns: 120px 1fr; }
    @media (max-width: 520px) { .field { grid-template-columns: 1fr; gap: 2px; } }
    .log-empty { padding: 48px 24px; text-align: center; }
    .log-empty .well { display: inline-flex; align-items: center; justify-content: center; width: 48px; height: 48px; border-radius: var(--r-md); background: var(--secondary); color: var(--secondary-foreground); margin-bottom: 12px; }
    .log-empty h3 { margin: 0 0 4px; font-size: 14px; font-weight: 700; color: var(--heading); }
    .log-empty p { margin: 0; font-size: 13px; color: var(--body); }

    @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    @keyframes pulse { 0% { transform: scale(1); opacity: .55; } 70% { transform: scale(2.6); opacity: 0; } 100% { opacity: 0; } }

    @media (max-width: 600px) {
      .grid { grid-template-columns: 1fr; }
      .full { grid-column: auto; }
      button.danger { margin-left: 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      main { animation: none; }
      .status-dot::after { animation: none; }
      .log-panel { transition: none; transform: none; }
      * { transition-duration: .01ms !important; }
    }
  </style>
</head>
<body>
  <main>
    <header class="app-header">
      <img class="brand" src="${LOGO_WORDMARK_DATA_URI}" alt="Meedo" width="88" height="30">
      <span class="brand-divider" aria-hidden="true"></span>
      <div class="brand-app">
        <span class="brand-app-name">Hikvision Sync Agent</span>
        <span class="brand-app-tag">Attendance sync · Asia/Manila</span>
      </div>
    </header>
    <p class="lede">Runs in the Windows system tray and synchronizes attendance in the background.</p>
    <div id="status-bar" class="status-bar" data-state="idle" role="status" aria-live="polite">
      <span class="status-dot" aria-hidden="true"></span>
      <span id="status">Loading status…</span>
    </div>
    <form id="config-form">
      <fieldset>
        <legend>Hikvision device</legend>
        <div class="grid">
          <div><label for="host">Host<abbr class="req" title="Required">*</abbr></label><input id="host" required placeholder="192.168.1.64"></div>
          <div><label for="username">Username<abbr class="req" title="Required">*</abbr></label><input id="username" required placeholder="admin"></div>
          <div class="full"><label for="password">Password<abbr class="req" title="Required">*</abbr></label><input id="password" type="password" required autocomplete="new-password"></div>
        </div>
      </fieldset>
      <fieldset>
        <legend>Sync destination</legend>
        <div class="grid">
          <div class="full"><label for="vps">API base URL<abbr class="req" title="Required">*</abbr></label><input id="vps" type="url" required placeholder="https://api.example.com"></div>
          <div class="full check"><label><input id="realtime" type="checkbox"> Enable real-time biometric trigger (scheduled recovery remains active)</label></div>
        </div>
      </fieldset>
      <fieldset>
        <legend>Schedule (Asia/Manila)</legend>
        <div class="grid">
          <div class="full"><label for="interval">Sync interval (minutes)<abbr class="req" title="Required">*</abbr></label><input id="interval" type="number" min="1" max="1440" step="1" required></div>
          <div><label for="start">Daily start<abbr class="req" title="Required">*</abbr></label><input id="start" type="time" required></div>
          <div><label for="end">Daily end<abbr class="req" title="Required">*</abbr></label><input id="end" type="time" required></div>
        </div>
      </fieldset>
      <div class="actions">
        <button class="primary" id="save" type="submit">Save and restart</button>
        <button id="sync" type="button">Sync now</button>
        <button id="logs" type="button">Open logs</button>
        <button id="hide" type="button">Hide to tray</button>
        <button class="danger" id="uninstall" type="button">Uninstall permanently</button>
      </div>
      <div id="message" role="alert" aria-live="assertive"></div>
    </form>
  </main>
  <div id="log-viewer" class="log-overlay" role="dialog" aria-modal="true" aria-labelledby="log-heading">
    <section class="log-panel">
      <div class="log-header"><h2 id="log-heading">Agent logs</h2><div class="spacer"></div><button id="close-logs" type="button">Close</button></div>
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
      end: document.getElementById('end'), realtime: document.getElementById('realtime')
    };
    const message = document.getElementById('message');
    const status = document.getElementById('status');
    const statusBar = document.getElementById('status-bar');
    if (!api) { status.textContent = 'Desktop bridge failed to load. Restart or reinstall the agent.'; statusBar.dataset.state = 'error'; }
    const logViewer = document.getElementById('log-viewer');
    const logEntriesElement = document.getElementById('log-entries');
    let logEntries = [];
    let lastFocused = null;
    function showMessage(text, error) { message.textContent = text; message.className = error ? 'error' : ''; }
    const ACRONYMS = { id: 'ID', url: 'URL', uri: 'URI', ip: 'IP', api: 'API', vps: 'VPS', http: 'HTTP', https: 'HTTPS', ok: 'OK', ms: 'ms', json: 'JSON', xml: 'XML' };
    function humanizeKey(key) {
      const words = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().split(/\\s+/);
      return words.map((word) => { const lower = word.toLowerCase(); return ACRONYMS[lower] || (lower.charAt(0).toUpperCase() + lower.slice(1)); }).join(' ') || String(key);
    }
    function maybeDate(key, num) {
      if (/(at|time|timestamp|date)$/i.test(key) && num > 100000000000) { const parsed = new Date(num); if (!Number.isNaN(parsed.getTime())) return parsed.toLocaleString(); }
      return String(num);
    }
    function fillValue(dd, key, value, depth) {
      if (value === null || value === undefined) { dd.textContent = 'None'; return false; }
      if (typeof value === 'boolean') { dd.textContent = value ? 'Yes' : 'No'; return false; }
      if (typeof value === 'number') { dd.textContent = maybeDate(key, value); return false; }
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.length > 68 || trimmed.includes('\\n')) { const pre = document.createElement('pre'); pre.textContent = value; dd.appendChild(pre); return true; }
        dd.textContent = trimmed || '—'; return false;
      }
      if (Array.isArray(value)) {
        if (!value.length) { dd.textContent = '—'; return false; }
        if (value.every((item) => item === null || typeof item !== 'object')) { dd.textContent = value.map((item) => (item === null ? 'None' : String(item))).join(', '); return false; }
        if (depth >= 2) { const pre = document.createElement('pre'); pre.textContent = JSON.stringify(value, null, 2); dd.appendChild(pre); return true; }
        const nested = document.createElement('dl'); nested.className = 'log-fields log-fields--nested';
        value.forEach((item, index) => appendField(nested, '#' + (index + 1), item, depth + 1)); dd.appendChild(nested); return true;
      }
      if (depth >= 2) { const pre = document.createElement('pre'); pre.textContent = JSON.stringify(value, null, 2); dd.appendChild(pre); return true; }
      const nested = document.createElement('dl'); nested.className = 'log-fields log-fields--nested';
      for (const [innerKey, innerValue] of Object.entries(value)) appendField(nested, innerKey, innerValue, depth + 1);
      dd.appendChild(nested); return true;
    }
    function appendField(list, key, value, depth) {
      const field = document.createElement('div');
      const dt = document.createElement('dt'); dt.textContent = humanizeKey(key);
      const dd = document.createElement('dd');
      const block = fillValue(dd, key, value, depth || 0);
      field.className = block ? 'field field--block' : 'field';
      field.append(dt, dd); list.appendChild(field);
    }
    function statusState(value) {
      if (value.lastListenerError) return 'error';
      const listener = String(value.listenerState || '').toLowerCase();
      if (listener.includes('error')) return 'error';
      if (listener.includes('reconnect') || value.pendingSync) return 'warn';
      if (['running', 'listening', 'connected', 'active'].includes(listener)) return 'ok';
      return 'idle';
    }
    async function refreshStatus() {
      const value = await api.getStatus();
      const details = [
        'Listener: ' + String(value.listenerState || 'stopped').replaceAll('_', ' '),
        value.pendingSync ? 'follow-up sync pending' : '',
        value.lastRealtimeEvent ? 'last event ' + new Date(value.lastRealtimeEvent).toLocaleString() : '',
        value.lastEventTriggeredSync ? 'last event sync ' + new Date(value.lastEventTriggeredSync).toLocaleString() : '',
        value.reconnectAttempt ? 'reconnect attempt ' + value.reconnectAttempt : '',
        value.lastListenerError ? 'listener error: ' + value.lastListenerError : ''
      ].filter(Boolean).join(' · ');
      status.textContent = value.message + (value.lastRun ? ' Last run: ' + new Date(value.lastRun).toLocaleString() + '.' : '') + (details ? ' ' + details + '.' : '');
      statusBar.dataset.state = statusState(value);
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
      fields.realtime.checked = config.REALTIME_ENABLED !== false;
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
        const empty = document.createElement('div');
        empty.className = 'log-empty';
        empty.innerHTML = '<div class="well"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6"/><path d="M9 17h4"/></svg></div><h3>No matching entries</h3><p>Adjust the search or level filter to see more.</p>';
        logEntriesElement.appendChild(empty);
        return;
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
        const details = Object.entries(entry).filter(([key, value]) => !['timestamp', 'level', 'event'].includes(key) && value !== null && value !== '' && value !== undefined);
        if (details.length) {
          const list = document.createElement('dl'); list.className = 'log-fields';
          for (const [key, value] of details) appendField(list, key, value, 0);
          row.appendChild(list);
        }
        logEntriesElement.appendChild(row);
      }
    }
    async function refreshLogs() { logEntries = await api.getLogs(); renderLogs(); }
    async function openLogViewer() {
      lastFocused = document.activeElement;
      logViewer.classList.add('open');
      await refreshLogs();
      document.getElementById('log-search').focus();
    }
    function closeLogViewer() {
      logViewer.classList.remove('open');
      if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
    }
    document.getElementById('config-form').addEventListener('submit', async (event) => {
      event.preventDefault(); showMessage('Saving…');
      const result = await api.saveConfig({
        HIKVISION_HOST: fields.host.value, HIKVISION_USER: fields.username.value,
        HIKVISION_PASS: fields.password.value, VPS_URL: fields.vps.value,
        SYNC_INTERVAL_MINUTES: Number(fields.interval.value),
        SYNC_START_TIME: fields.start.value, SYNC_END_TIME: fields.end.value,
        REALTIME_ENABLED: fields.realtime.checked
      });
      showMessage(result.message, !result.ok);
    });
    document.getElementById('sync').addEventListener('click', async () => { showMessage((await api.syncNow()).message); await refreshStatus(); });
    document.getElementById('logs').addEventListener('click', () => void openLogViewer());
    document.getElementById('hide').addEventListener('click', () => api.hideWindow());
    document.getElementById('uninstall').addEventListener('click', async () => { const result = await api.uninstall(); if (result) showMessage(result.message, !result.ok); });
    document.getElementById('close-logs').addEventListener('click', closeLogViewer);
    logViewer.addEventListener('click', (event) => { if (event.target === logViewer) closeLogViewer(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && logViewer.classList.contains('open')) closeLogViewer(); });
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
