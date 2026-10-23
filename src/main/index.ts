// @ts-ignore
import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
// @ts-ignore
const Store = require('electron-store');
// @ts-ignore
import { ConnectionManager } from '../../backend/src/connection';
import type {
  ConnectionProfile,
  ConnectionSummary,
  ExecutionResult,
  ValidateResult,
  TableInfo,
  ColumnInfo,
} from '../shared/types';
import { CHANNELS } from '../shared/channels';

type StoredProfile = ConnectionProfile & { id: string };

const store = new Store({ defaults: { profiles: [] } });

function getProfiles(): StoredProfile[] {
  return store.get('profiles', []);
}
function setProfiles(profiles: StoredProfile[]): void {
  store.set('profiles', profiles);
}

/** Passwords are held in memory for the session and never logged. */
function redacted(p: StoredProfile): StoredProfile {
  return { ...p, password: p.password ? '***REDACTED***' : undefined };
}

const manager = new ConnectionManager();
let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'RiduDB Studio',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  if (process.env.NODE_ENV === 'development' && mainWindow.webContents) {
    // @ts-ignore
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  setupIpc();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', async () => {
  await manager.closeAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  await manager.closeAll();
});

process.on('SIGTERM', async () => {
  await manager.closeAll();
  app.exit(0);
});
process.on('SIGINT', async () => {
  await manager.closeAll();
  app.exit(0);
});

function setupIpc(): void {
  // ---- Profile validation (no connection opened) ----
  ipcMain.handle(
    CHANNELS.VALIDATE,
    async (_e, payload: { profile: ConnectionProfile }): Promise<ValidateResult> => {
      return manager.validate(payload.profile);
    },
  );

  // ---- Connection lifecycle ----
  ipcMain.handle(
    CHANNELS.CONNECT,
    async (_e, payload: { profile: ConnectionProfile }) => {
      try {
        const result = await manager.connect(payload.profile);
        const profile: StoredProfile = {
          id: result.connectionId,
          ...payload.profile,
        };
        const profiles = getProfiles();
        profiles.push(profile);
        setProfiles(profiles);
        return {
          ok: true,
          data: {
            connectionId: result.connectionId,
            engine: result.engine,
            database: result.database,
          },
        };
      } catch (err: any) {
        return { ok: false, error: err?.message || 'Connection failed' };
      }
    },
  );

  ipcMain.handle(
    CHANNELS.DISCONNECT,
    async (_e, connectionId: string) => {
      try {
        const result = await manager.disconnect(connectionId);
        return { ok: result.ok, data: { connectionId } };
      } catch (err: any) {
        return { ok: false, error: err?.message || 'Disconnect failed' };
      }
    },
  );

  ipcMain.handle(CHANNELS.LIST_CONNECTIONS, async () => {
    const list = manager.listConnections();
    const summaries: ConnectionSummary[] = list.connections.map((c: any) => ({
      connectionId: c.connectionId,
      engine: c.engine,
      database: c.database,
    }));
    return { ok: true, data: summaries };
  });

  // ---- Saved profiles (in-memory only for the session) ----
  ipcMain.handle(
    CHANNELS.SAVE_PROFILE,
    async (_e, payload: { profile: StoredProfile }) => {
      try {
        const profiles = getProfiles();
        const idx = profiles.findIndex((p) => p.id === payload.profile.id);
        if (idx >= 0) profiles[idx] = payload.profile;
        else profiles.push(payload.profile);
        setProfiles(profiles);
        return { ok: true, data: undefined };
      } catch (err: any) {
        return { ok: false, error: err?.message || 'Failed to save profile' };
      }
    },
  );

  ipcMain.handle(CHANNELS.LOAD_PROFILES, async () => {
    return { ok: true, data: getProfiles().map(redacted) };
  });

  ipcMain.handle(
    CHANNELS.DELETE_PROFILE,
    async (_e, id: string) => {
      try {
        setProfiles(getProfiles().filter((p) => p.id !== id));
        await manager.disconnect(id).catch(() => {});
        return { ok: true, data: undefined };
      } catch (err: any) {
        return { ok: false, error: err?.message || 'Failed to delete profile' };
      }
    },
  );

  // ---- Schema inspection ----
  ipcMain.handle(
    CHANNELS.INSPECT_SCHEMA,
    async (_e, payload: { connectionId: string }) => {
      try {
        const result = await manager.listTables(payload.connectionId);
        const tables: TableInfo[] = (result.tables || []).map((t: any) => ({
          name: t.name,
          type: t.type === 'table' ? 'table' : 'view',
        }));
        return { ok: true, data: { tables } };
      } catch (err: any) {
        return { ok: false, error: err?.message || 'Failed to inspect schema' };
      }
    },
  );

  ipcMain.handle(
    CHANNELS.GET_COLUMNS,
    async (_e, payload: { connectionId: string; tableName: string }) => {
      try {
        const result = await manager.listColumns(
          payload.connectionId,
          payload.tableName,
        );
        const columns: ColumnInfo[] = (result.columns || []).map((c: any) => ({
          name: c.name,
          dataType: c.dataType,
          isNullable: c.isNullable,
          defaultValue: c.defaultValue,
          maxLength: c.maxLength ?? null,
        }));
        return { ok: true, data: { columns } };
      } catch (err: any) {
        return { ok: false, error: err?.message || 'Failed to list columns' };
      }
    },
  );

  // ---- Query execution ----
  ipcMain.handle(
    CHANNELS.QUERY,
    async (
      _e,
      payload: { connectionId: string; sql: string; params?: any[]; limit?: number },
    ): Promise<{ ok: boolean; data?: ExecutionResult; error?: string }> => {
      try {
        const result: ExecutionResult = await manager.executeQuery(
          payload.connectionId,
          { sql: payload.sql, params: payload.params ?? [], limit: payload.limit ?? 1000 },
        );
        return { ok: true, data: result };
      } catch (err: any) {
        return {
          ok: false,
          error: err?.message || 'Query failed',
        };
      }
    },
  );
}
