/**
 * RiduDB Studio - renderer (frontend) application.
 *
 * Owns the connection manager UI, SQL editor, schema explorer, results grid,
 * and loading/error states. Communicates with the main process exclusively
 * through `window.ridubAPI`, exposed by the preload script via contextBridge.
 *
 * Database passwords are read from form fields and passed to ridubAPI, but are
 * never logged or printed to the console.
 */

import type {
  ConnectionProfile,
  DbEngine,
  ConnectionSummary,
  ExecutionResult,
  TableInfo,
  ColumnInfo,
} from '../shared/types';

interface RidubApi {
  validateProfile: (profile: ConnectionProfile) => Promise<{
    ok: boolean;
    data?: { valid: boolean; errors: string[] };
    error?: string;
  }>;
  connectDatabase: (profile: ConnectionProfile) => Promise<{
    ok: boolean;
    data?: { connectionId: string; engine: string; database: string };
    error?: string;
  }>;
  closeDatabase: (id: string) => Promise<{ ok: boolean; error?: string }>;
  getConnectionStatus: () => Promise<{
    ok: boolean;
    data?: { connections: ConnectionSummary[] };
    error?: string;
  }>;
  saveProfile: (profile: ConnectionProfile & { id: string }) => Promise<{ ok: boolean; error?: string }>;
  loadProfiles: () => Promise<{ ok: boolean; data?: ConnectionProfile[]; error?: string }>;
  deleteProfile: (id: string) => Promise<{ ok: boolean; error?: string }>;
  inspectSchema: (connectionId: string) => Promise<{
    ok: boolean;
    data?: { tables: TableInfo[] };
    error?: string;
  }>;
  getColumns: (connectionId: string, tableName: string) => Promise<{
    ok: boolean;
    data?: { columns: ColumnInfo[] };
    error?: string;
  }>;
  executeQuery: (
    connectionId: string,
    sql: string,
    params: any[],
    limit: number,
  ) => Promise<{ ok: boolean; data?: ExecutionResult; error?: string }>;
  selectDatabaseFile?: () => Promise<string | null>;
  readClipboardText?: () => Promise<string>;
  writeClipboardText?: (text: string) => Promise<boolean>;
  onFileSelected?: (callback: (path: string) => void) => void;
}

declare global {
  interface Window {
    ridubAPI: RidubApi;
  }
}

const api = window.ridubAPI;

// ---------- DOM ----------
const el = {
  indicator: document.getElementById('indicator')! as HTMLElement,
  statusText: document.getElementById('statusText')! as HTMLElement,
  profileName: document.getElementById('profileName')! as HTMLInputElement,
  engine: document.getElementById('engine')! as HTMLSelectElement,
  fieldPath: document.getElementById('fieldPath')! as HTMLInputElement,
  pgHost: document.getElementById('pgHost')! as HTMLInputElement,
  pgPort: document.getElementById('pgPort')! as HTMLInputElement,
  pgDatabase: document.getElementById('pgDatabase')! as HTMLInputElement,
  pgUser: document.getElementById('pgUser')! as HTMLInputElement,
  pgPassword: document.getElementById('pgPassword')! as HTMLInputElement,
  myHost: document.getElementById('myHost')! as HTMLInputElement,
  myPort: document.getElementById('myPort')! as HTMLInputElement,
  myDatabase: document.getElementById('myDatabase')! as HTMLInputElement,
  myUser: document.getElementById('myUser')! as HTMLInputElement,
  myPassword: document.getElementById('myPassword')! as HTMLInputElement,
  btnValidate: document.getElementById('btnValidate')! as HTMLButtonElement,
  btnConnect: document.getElementById('btnConnect')! as HTMLButtonElement,
  btnDisconnect: document.getElementById('btnDisconnect')! as HTMLButtonElement,
  btnRefreshSchema: document.getElementById('btnRefreshSchema')! as HTMLButtonElement,
  sqlEditor: document.getElementById('sqlEditor')! as HTMLTextAreaElement,
  queryLimit: document.getElementById('queryLimit')! as HTMLInputElement,
  btnRun: document.getElementById('btnRun')! as HTMLButtonElement,
  profilesList: document.getElementById('profilesList')! as HTMLElement,
  schemaList: document.getElementById('schemaList')! as HTMLElement,
  errorBox: document.getElementById('errorBox')! as HTMLElement,
  resultsContainer: document.getElementById('resultsContainer')! as HTMLElement,
  resultsMeta: document.getElementById('resultsMeta')! as HTMLElement,
  resultStatus: document.getElementById('resultStatus')! as HTMLElement,
  btnBrowsePath: document.getElementById('btnBrowsePath') as HTMLButtonElement | null,
  btnPastePath: document.getElementById('btnPastePath') as HTMLButtonElement | null,
  btnPasteSql: document.getElementById('btnPasteSql') as HTMLButtonElement | null,
};

const fieldContainers: Record<string, HTMLElement> = {
  sqlite: document.getElementById('field-sqlite')!,
  postgres: document.getElementById('field-postgres')!,
  mysql: document.getElementById('field-mysql')!,
};

// ---------- Clipboard helper ----------
async function getClipboardText(): Promise<string> {
  try {
    if (api && api.readClipboardText) {
      const text = await api.readClipboardText();
      if (typeof text === 'string') return text;
    }
  } catch {
    /* fallback */
  }
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      return await navigator.clipboard.readText();
    }
  } catch {
    /* ignore */
  }
  return '';
}

// ---------- State ----------
let activeConnectionId: string | null = null;
let tablesById = new Map<string, TableInfo>();

// ---------- Init ----------
document.addEventListener('DOMContentLoaded', async () => {
  wireListeners();
  el.engine.value = 'sqlite';
  showEngineFields('sqlite');
  await loadProfiles();
});

function wireListeners(): void {
  el.engine.addEventListener('change', (e) => {
    showEngineFields((e.target as HTMLSelectElement).value as DbEngine);
  });

  el.btnValidate.addEventListener('click', () => handleValidate());
  el.btnConnect.addEventListener('click', () => handleConnect());
  el.btnDisconnect.addEventListener('click', () => handleDisconnect());
  el.btnRefreshSchema.addEventListener('click', () => refreshSchema());

  el.btnRun.addEventListener('click', () => handleRunQuery());

  el.sqlEditor.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); handleRunQuery(); }
  });

  // Browse SQLite database file dialog
  if (el.btnBrowsePath) {
    el.btnBrowsePath.addEventListener('click', async () => {
      try {
        if (api && api.selectDatabaseFile) {
          const selected = await api.selectDatabaseFile();
          if (selected) {
            el.fieldPath.value = selected;
            el.fieldPath.dispatchEvent(new Event('input', { bubbles: true }));
            clearError();
          }
        }
      } catch (err) {
        showError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  // Paste into SQLite database path
  if (el.btnPastePath) {
    el.btnPastePath.addEventListener('click', async () => {
      const text = await getClipboardText();
      if (text) {
        const cleaned = text.trim().replace(/^['"]|['"]$/g, '');
        el.fieldPath.value = cleaned;
        el.fieldPath.dispatchEvent(new Event('input', { bubbles: true }));
        clearError();
      }
    });
  }

  // Paste into SQL Editor
  if (el.btnPasteSql) {
    el.btnPasteSql.addEventListener('click', async () => {
      const text = await getClipboardText();
      if (text) {
        el.sqlEditor.value = text;
        el.sqlEditor.dispatchEvent(new Event('input', { bubbles: true }));
        el.sqlEditor.focus();
      }
    });
  }

  // Listen for file selected from main menu (File -> Open SQLite Database...)
  if (api && api.onFileSelected) {
    api.onFileSelected((filePath: string) => {
      if (filePath) {
        el.engine.value = 'sqlite';
        showEngineFields('sqlite');
        el.fieldPath.value = filePath;
        el.fieldPath.dispatchEvent(new Event('input', { bubbles: true }));
        clearError();
      }
    });
  }
}

function showEngineFields(engine: DbEngine): void {
  Object.values(fieldContainers).forEach((c) => c.classList.add('hidden'));
  fieldContainers[engine]?.classList.remove('hidden');
}

// ---------- Profiles ----------
async function loadProfiles(): Promise<void> {
  try {
    const res = await api.loadProfiles();
    if (!res.ok) throw new Error(res.error || 'Failed to load profiles');
    renderProfiles(res.data || []);
  } catch (err) {
    renderProfiles([]);
    // Profiles are optional; don't hard-fail the app on load error.
    console.warn('profile load', err);
  }
}

function renderProfiles(profiles: ConnectionProfile[]): void {
  if (profiles.length === 0) {
    el.profilesList.innerHTML = '<div class="empty">No saved profiles.</div>';
    return;
  }
  el.profilesList.innerHTML = '';
  for (const p of profiles) {
    const row = document.createElement('div');
    row.className = 'profile-row';
    const isSqlite = p.engine === 'sqlite';
    row.innerHTML = `
      <div class="name">${escapeHtml(p.name)}</div>
      <div class="engine">${p.engine} · ${escapeHtml(p.database)}</div>
      <button data-action="connect" data-id="${escapeAttr(p.id || '')}" data-engine="${escapeAttr(p.engine)}">Connect</button>
      <button data-action="delete" data-id="${escapeAttr(p.id || '')}" class="secondary" style="margin-left:6px">Delete</button>
    `;
    row.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action')!;
        const id = btn.getAttribute('data-id')!;
        if (action === 'connect') {
          const prof = profiles.find((x) => (x.id || '') === id);
          if (prof) loadProfileIntoForm(prof);
        } else if (action === 'delete') {
          handleDeleteProfile(id);
        }
      });
    });
    el.profilesList.appendChild(row);
  }
}

function loadProfileIntoForm(p: ConnectionProfile): void {
  el.profileName.value = p.name;
  el.engine.value = p.engine;
  showEngineFields(p.engine);
  const fill = (id: string, value: string | undefined) => {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (input) input.value = value || '';
  };
  fill('fieldPath', p.engine === 'sqlite' ? p.database : undefined);
  fill('pgHost', p.host); fill('pgPort', String(p.port || ''));
  fill('pgDatabase', p.database); fill('pgUser', p.username);
  // Password intentionally left blank for the user to re-enter (never pre-fill secrets).
  fill('pgPassword', '');
  fill('myHost', p.host); fill('myPort', String(p.port || ''));
  fill('myDatabase', p.database); fill('myUser', p.username);
  fill('myPassword', '');
}

// ---------- Connect / disconnect ----------
async function handleValidate(): Promise<void> {
  clearError();
  const profile = getProfileFromForm();
  try {
    const res = await api.validateProfile(profile);
    if (!res.ok) throw new Error(res.error || 'Validation failed');
    if (res.data?.valid) {
      showError('Profile is valid.');
      el.errorBox.style.background = '#1b4332';
      el.errorBox.style.borderColor = '#2d6a4f';
      el.errorBox.style.color = '#4ade80';
    } else {
      showError('Validation errors: ' + (res.data?.errors || []).join('; '));
    }
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

async function handleConnect(): Promise<void> {
  clearError();
  const profile = getProfileFromForm();
  el.btnConnect.disabled = true;
  try {
    const res = await api.connectDatabase(profile);
    el.btnConnect.disabled = false;
    if (!res.ok) throw new Error(res.error || 'Connection failed');
    const data = res.data!;
    activeConnectionId = data.connectionId;
    setStatus(true, data.database, data.engine as DbEngine);
    await saveProfileIfNew(profile, data.connectionId);
    await refreshSchema();
    await loadProfiles();
  } catch (err) {
    el.btnConnect.disabled = false;
    showError(err instanceof Error ? err.message : String(err));
    setStatus(false, '');
  }
}

async function saveProfileIfNew(profile: ConnectionProfile, connectionId: string): Promise<void> {
  try {
    const res = await api.loadProfiles();
    const profiles: ConnectionProfile[] = res.ok ? (res.data || []) : [];
    const exists = profiles.some((p) => (p.id || '') === connectionId || p.name === profile.name);
    if (!exists) {
      await api.saveProfile({ ...profile, id: connectionId } as ConnectionProfile & { id: string });
    }
  } catch { /* non-fatal */ }
}

async function handleDisconnect(): Promise<void> {
  if (!activeConnectionId) return;
  el.btnDisconnect.disabled = true;
  try {
    const res = await api.closeDatabase(activeConnectionId);
    if (!res.ok) showError(res.error || 'Disconnect failed');
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  } finally {
    activeConnectionId = null;
    el.btnDisconnect.disabled = true;
    setStatus(false, '');
    el.schemaList.innerHTML = 'Disconnected.';
    el.resultsContainer.innerHTML = '<div class="empty">Run a query to see results.</div>';
    el.resultsMeta.textContent = '';
    el.btnRun.disabled = true;
  }
}

async function handleDeleteProfile(id: string): Promise<void> {
  if (!confirm('Delete this saved profile?')) return;
  try {
    const res = await api.deleteProfile(id);
    if (!res.ok) throw new Error(res.error || 'Delete failed');
    await loadProfiles();
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

// ---------- Schema ----------
async function refreshSchema(): Promise<void> {
  if (!activeConnectionId) return;
  el.btnRefreshSchema.disabled = true;
  el.schemaList.innerHTML = '<div style="padding:8px 14px;color:var(--muted)">Loading schema…</div>';
  try {
    const res = await api.inspectSchema(activeConnectionId);
    el.btnRefreshSchema.disabled = false;
    if (!res.ok) throw new Error(res.error || 'Schema inspection failed');
    renderTables(res.data!.tables || []);
  } catch (err) {
    el.btnRefreshSchema.disabled = false;
    el.schemaList.innerHTML = `<div style="padding:8px 14px;color:var(--danger)">Failed to load schema: ${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

function renderTables(tables: TableInfo[]): void {
  tablesById = new Map(tables.map((t) => [t.name, t]));
  if (tables.length === 0) {
    el.schemaList.innerHTML = '<div class="empty">No tables or views found.</div>';
    return;
  }
  el.schemaList.innerHTML = '';
  for (const t of tables) {
    const item = document.createElement('div');
    item.className = 'schema-item';
    item.setAttribute('role', 'button');
    item.setAttribute('tabindex', '0');
    item.innerHTML = `<span class="kind">${t.type}</span>${escapeHtml(t.name)}`;
    item.addEventListener('click', () => renderTableColumns(t));
    item.addEventListener('keydown', (e) => { if (e.key === 'Enter') renderTableColumns(t); });
    el.schemaList.appendChild(item);
  }
}

function renderTableColumns(table: TableInfo): void {
  document.querySelectorAll('.schema-item').forEach((n) => n.classList.remove('selected'));
  const target = Array.from(el.schemaList.children).find((c) => c.textContent?.includes(table.name));
  target?.classList.add('selected');

  if (table.columns && table.columns.length > 0) {
    let html = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><button id="btnBackToTables" class="secondary" style="padding:4px 10px">&#8592; Tables</button><strong>${escapeHtml(table.name)}</strong> <span style="color:var(--muted);font-size:11px">${table.type} &bull; ${table.columns.length} column(s)</span></div>`;
    html += `<table class="results"><thead><tr>`;
    for (const c of table.columns) html += `<th>${escapeHtml(c.name)}</th><th style="width:150px">${escapeHtml(c.dataType)}</th></tr></thead><tbody>`;
    for (const c of table.columns) html += `<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(String(c.dataType))}</td></tr>`;
    html += `</tbody></table>`;
    el.schemaList.innerHTML = `<div style="padding:10px 14px">${html}</div>`;
    (document.getElementById('btnBackToTables') as HTMLButtonElement).onclick = () =>
      renderTables(Array.from(tablesById.values()));
    return;
  }
  // Columns not preloaded; fetch them.
  fetchAndRenderTableColumns(table);
}

async function fetchAndRenderTableColumns(table: TableInfo): Promise<void> {
  if (!activeConnectionId) return;
  try {
    const res = await api.getColumns(activeConnectionId, table.name);
    if (!res.ok) throw new Error(res.error || 'Failed to load columns');
    const enriched: TableInfo = { ...table, columns: res.data!.columns };
    renderTableColumns(enriched);
  } catch (err) {
    el.schemaList.innerHTML = `<div style="padding:8px 14px;color:var(--danger)">Failed to load columns: ${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

// ---------- Query ----------
async function handleRunQuery(): Promise<void> {
  if (!activeConnectionId) {
    showError('Connect to a database before running a query.');
    return;
  }
  const sql = el.sqlEditor.value.trim();
  if (!sql) { showError('Enter a SQL statement.'); return; }
  const limit = Number(el.queryLimit.value) || 100;

  clearError();
  el.btnRun.disabled = true;
  el.resultsContainer.innerHTML = '<div style="padding:10px 14px;color:var(--muted)">Executing…</div>';
  el.resultsMeta.textContent = '';
  el.resultStatus.textContent = '';

  try {
    const res = await api.executeQuery(activeConnectionId, sql, [], limit);
    el.btnRun.disabled = false;
    if (!res.ok) throw new Error(res.error || 'Query failed');
    renderResults(res.data!);
  } catch (err) {
    el.btnRun.disabled = false;
    const msg = err instanceof Error ? err.message : String(err);
    showError(msg);
    el.resultsContainer.innerHTML = '<div class="empty">Query failed.</div>';
  }
}

function renderResults(result: ExecutionResult): void {
  const { columns, rows } = result;
  el.resultStatus.textContent = `OK · ${result.rowCount} row(s) · ${result.durationMs} ms`;
  if (result.truncated) {
    el.resultStatus.textContent += ` · truncated at ${limitValue()} rows`;
  }

  el.resultsContainer.innerHTML = '';
  const table = document.createElement('table');
  table.className = 'results';
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const c of columns) { const th = document.createElement('th'); th.textContent = c.name; headerRow.appendChild(th); }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  if (rows.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = columns.length || 1;
    td.className = 'empty';
    td.textContent = 'No rows returned.';
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    for (const row of rows) {
      const tr = document.createElement('tr');
      for (const c of columns) {
        const td = document.createElement('td');
        const val = row[columns.indexOf(c)];
        if (val === null || val === undefined) {
          td.textContent = '(null)';
          td.className = 'null-cell';
        } else {
          td.textContent = String(val);
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }
  table.appendChild(tbody);
  el.resultsContainer.appendChild(table);

  const meta = `Columns: ${columns.length} · Rows: ${result.rowCount} · Execution: ${result.durationMs} ms${result.truncated ? ' · truncated' : ''}`;
  el.resultsMeta.textContent = meta;
}

function limitValue(): number {
  return Number(el.queryLimit.value) || 100;
}

// ---------- UI helpers ----------
function setStatus(connected: boolean, database: string, engine?: DbEngine): void {
  el.indicator.className = `indicator ${connected ? 'connected' : 'disconnected'}`;
  el.statusText.textContent = connected
    ? `Connected · ${escapeHtml(database)} (${engine})`
    : 'Disconnected';
  el.btnDisconnect.disabled = !connected;
  el.btnRun.disabled = !connected;
  el.sqlEditor.disabled = !connected;
}

function showError(message: string): void {
  el.errorBox.textContent = message;
  el.errorBox.classList.remove('hidden');
  el.errorBox.style.background = '#450a0a';
  el.errorBox.style.borderColor = '#7f1d1d';
  el.errorBox.style.color = '#fecaca';
  setTimeout(() => { el.errorBox.classList.add('hidden'); }, 8000);
}

function clearError(): void {
  el.errorBox.classList.add('hidden');
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;');
}

function getProfileFromForm(): ConnectionProfile {
  const engine = el.engine.value as DbEngine;
  const base: ConnectionProfile = {
    name: el.profileName.value.trim() || `${engine} connection`,
    engine,
    database: '',
  };
  if (engine === 'sqlite') {
    base.database = el.fieldPath.value.trim() || ':memory:';
  } else {
    base.host = el.pgHost.value.trim() || 'localhost';
    base.port = Number(el.pgPort.value) || (engine === 'postgres' ? 5432 : 3306);
    base.database = el.pgDatabase.value.trim() || el.myDatabase.value.trim();
    base.username = el.pgUser.value.trim() || el.myUser.value.trim() || undefined;
    const pw = engine === 'postgres' ? el.pgPassword.value : el.myPassword.value;
    if (pw) base.password = pw;
  }
  return base;
}
