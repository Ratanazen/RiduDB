/**
 * IPC channel names used between the renderer and the Electron main process.
 * The preload script exposes these to the renderer via contextBridge as
 * `window.ridubAPI`. The main process handles them and delegates to the
 * backend `ConnectionManager` (`backend/src/index.js`).
 *
 * All calls use `ipcRenderer.invoke` (promise-based, request/response).
 * The main process never pushes unsolicited data to the renderer.
 */

export const CHANNELS = {
  // Profile validation (client-side, no connection opened)
  VALIDATE: 'db:validate',

  // Connection lifecycle
  CONNECT: 'db:connect',
  DISCONNECT: 'db:disconnect',
  LIST_CONNECTIONS: 'db:listConnections',

  // Saved profiles (persisted in main process via electron-store)
  SAVE_PROFILE: 'db:saveProfile',
  LOAD_PROFILES: 'db:loadProfiles',
  DELETE_PROFILE: 'db:deleteProfile',

  // Schema inspection
  INSPECT_SCHEMA: 'db:inspectSchema',   // -> listTables
  GET_COLUMNS: 'db:getColumns',          // -> listColumns for one table

  // Query execution
  QUERY: 'db:query',
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];
