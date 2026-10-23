import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS } from '../shared/channels';

// Use contextBridge to safely expose IPC methods to the renderer process.
// Only expose what is needed - never expose node APIs directly.
contextBridge.exposeInMainWorld('ridubAPI', {
  // Connection management
  validateProfile: (profile: any) =>
    ipcRenderer.invoke(CHANNELS.VALIDATE, { profile }),
  connectDatabase: (profile: any) =>
    ipcRenderer.invoke(CHANNELS.CONNECT, { profile }),
  closeDatabase: (id: string) => ipcRenderer.invoke(CHANNELS.DISCONNECT, id),
  saveProfile: (profile: any) => ipcRenderer.invoke(CHANNELS.SAVE_PROFILE, { profile }),
  loadProfiles: () => ipcRenderer.invoke(CHANNELS.LOAD_PROFILES),
  deleteProfile: (id: string) => ipcRenderer.invoke(CHANNELS.DELETE_PROFILE, id),

  // Schema inspection
  inspectSchema: (connectionId: string) =>
    ipcRenderer.invoke(CHANNELS.INSPECT_SCHEMA, { connectionId }),
  getColumns: (connectionId: string, tableName: string) =>
    ipcRenderer.invoke(CHANNELS.GET_COLUMNS, {
      connectionId,
      tableName,
    }),

  // Query execution
  executeQuery: (
    connectionId: string,
    sql: string,
    params: any[] = [],
    limit: number = 1000,
  ) =>
    ipcRenderer.invoke(CHANNELS.QUERY, { connectionId, sql, params, limit }),

  // Status
  getConnectionStatus: () => ipcRenderer.invoke(CHANNELS.LIST_CONNECTIONS),

  // File dialog & Clipboard utilities
  selectDatabaseFile: () => ipcRenderer.invoke('dialog:openFile'),
  readClipboardText: () => ipcRenderer.invoke('clipboard:readText'),
  writeClipboardText: (text: string) => ipcRenderer.invoke('clipboard:writeText', text),

  // Event subscriptions
  onQueryComplete: (callback: (result: any) => void) =>
    ipcRenderer.on('query-complete', (_, result: any) => callback(result)),
  onConnectionChanged: (callback: (status: any) => void) =>
    ipcRenderer.on('connection-changed', (_, status: any) => callback(status)),
  onFileSelected: (callback: (filePath: string) => void) =>
    ipcRenderer.on('app:file-selected', (_, filePath: string) => callback(filePath)),
});
