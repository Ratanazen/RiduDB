'use strict';

const { RiduDBError, DRIVER_CODES } = require('../errors');

// Base driver interface. Each engine driver (sqlite, postgres, mysql) extends
// this and implements the abstract methods. Frontend-agnostic: drivers deal
// only with plain data objects, never with UI state.

const READ_ONLY_PREFIXES = [
  'select',
  'pragma',
  'show',
  'describe',
  'desc',
  'explain',
  'with', // may lead into a SELECT; validated more strictly by drivers
];

const DESTRUCTIVE_KEYWORDS = [
  'insert',
  'update',
  'delete',
  'drop',
  'truncate',
  'alter',
  'create',
  'replace',
  'merge',
  'attach',
  'detach',
  'load',
  'pragma',
];

function firstKeyword(sql) {
  const m = String(sql || '').match(/^\s*([A-Za-z]+)/);
  return m ? m[1].toLowerCase() : '';
}

function isReadOnly(sql) {
  const kw = firstKeyword(sql);
  if (!READ_ONLY_PREFIXES.includes(kw)) return false;
  // `pragma` is read-only only for a safe subset; drivers override as needed.
  if (kw === 'pragma') return true;
  if (kw === 'with') {
    // A CTE must ultimately be a SELECT; drivers perform a fuller scan.
    return true;
  }
  return true;
}

function containsDestructive(sql) {
  const s = String(sql || '').toLowerCase();
  return DESTRUCTIVE_KEYWORDS.some((kw) => {
    // Match whole words to avoid false positives (e.g. "delete" inside "undeletable").
    const re = new RegExp(`\\b${kw}\\b`);
    return re.test(s);
  });
}

class BaseDriver {
  constructor(engine) {
    this.engine = engine; // 'sqlite' | 'postgres' | 'mysql'
    this._connected = false;
    this._connection = null;
  }

  get connected() {
    return this._connected;
  }

  // Abstract: open a connection from a profile.
  async connect(profile) {
    throw new RiduDBError({
      code: DRIVER_CODES.DRIVER_ERROR,
      message: `connect() not implemented for ${this.engine}`,
      driver: 'base',
    });
  }

  // Abstract: close the connection.
  async disconnect() {
    this._connected = false;
    this._connection = null;
  }

  // Abstract: list tables/views.
  async listTables() {
    throw new RiduDBError({
      code: DRIVER_CODES.DRIVER_ERROR,
      message: `listTables() not implemented for ${this.engine}`,
      driver: 'base',
    });
  }

  // Abstract: list columns for a table.
  async listColumns(_tableName) {
    throw new RiduDBError({
      code: DRIVER_CODES.DRIVER_ERROR,
      message: `listColumns() not implemented for ${this.engine}`,
      driver: 'base',
    });
  }

  // Abstract: execute a read-only query.
  async executeQuery(_params) {
    throw new RiduDBError({
      code: DRIVER_CODES.DRIVER_ERROR,
      message: `executeQuery() not implemented for ${this.engine}`,
      driver: 'base',
    });
  }

  // Abstract: cancel a running query (optional).
  async cancelQuery() {
    return { ok: true };
  }

  // Abstract: begin a transaction.
  async beginTransaction() {
    throw new RiduDBError({
      code: DRIVER_CODES.DRIVER_ERROR,
      message: `beginTransaction() not implemented for ${this.engine}`,
      driver: 'base',
    });
  }

  // Abstract: commit the current transaction.
  async commit() {
    throw new RiduDBError({
      code: DRIVER_CODES.DRIVER_ERROR,
      message: `commit() not implemented for ${this.engine}`,
      driver: 'base',
    });
  }

  // Abstract: roll back the current transaction.
  async rollback() {
    throw new RiduDBError({
      code: DRIVER_CODES.DRIVER_ERROR,
      message: `rollback() not implemented for ${this.engine}`,
      driver: 'base',
    });
  }

  // Validate that a SQL statement is read-only. Returns { ok, reason }.
  validateSql(sql) {
    if (!sql || typeof sql !== 'string' || !sql.trim()) {
      return { ok: false, reason: 'Empty SQL statement' };
    }
    if (!isReadOnly(sql)) {
      return {
        ok: false,
        reason: 'Only read-only statements (SELECT, PRAGMA, SHOW, DESCRIBE, EXPLAIN) are allowed',
      };
    }
    if (containsDestructive(sql)) {
      return {
        ok: false,
        reason: 'Statement contains a destructive keyword and was rejected',
      };
    }
    return { ok: true };
  }

  // Build a standardized execution result.
  buildResult({ columns, rows, truncated, durationMs, status = 'ok', error }) {
    return {
      status,
      columns: columns || [],
      rows: rows || [],
      rowCount: (rows || []).length,
      truncated: !!truncated,
      durationMs: durationMs || 0,
      ...(error ? { error } : {}),
    };
  }
}

module.exports = { BaseDriver, isReadOnly, containsDestructive, firstKeyword };
