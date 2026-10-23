'use strict';

const { ConnectionManager } = require('./connection');

// Singleton backend API. Frontend/IPC layer calls these methods directly.
// All methods are asynchronous and return plain objects.

const manager = new ConnectionManager();

// Graceful shutdown: close all open connections on process exit.
function shutdown() {
  return manager.closeAll();
}
if (typeof process !== 'undefined') {
  process.on('exit', () => {
    try {
      manager.closeAll();
    } catch (err) {
      // ignore during shutdown
    }
  });
  process.on('SIGINT', () => {
    shutdown().then(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    shutdown().then(() => process.exit(0));
  });
}

async function validate(profile) {
  return manager.validate(profile);
}

async function connect(profile) {
  return manager.connect(profile);
}

async function disconnect(connectionId) {
  return manager.disconnect(connectionId);
}

function listConnections() {
  return manager.listConnections();
}

async function listTables(connectionId) {
  return manager.listTables(connectionId);
}

async function listColumns(connectionId, tableName) {
  return manager.listColumns(connectionId, tableName);
}

async function executeQuery(connectionId, params) {
  return manager.executeQuery(connectionId, params);
}

async function cancelQuery(connectionId) {
  return manager.cancelQuery(connectionId);
}

module.exports = {
  validate,
  connect,
  disconnect,
  listConnections,
  listTables,
  listColumns,
  executeQuery,
  cancelQuery,
  ConnectionManager,
};
