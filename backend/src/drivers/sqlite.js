'use strict';

const path = require('path');
const fs = require('fs');
const { BaseDriver } = require('./base');
const { RiduDBError, DRIVER_CODES, normalizeDriverError } = require('../errors');

// sql.js loads its WASM binary asynchronously. We load it once and reuse the API.
let SqlApi = null;
let sqlInitPromise = null;

function ensureSql() {
  if (SqlApi) return Promise.resolve(SqlApi);
  if (!sqlInitPromise) {
    // require('sql.js') returns a factory function; calling it loads the WASM
    // binary and resolves to the { Database, ... } API.
    const factory = require('sql.js');
    sqlInitPromise = factory().then((api) => {
      SqlApi = api;
      return api;
    });
  }
  return sqlInitPromise;
}

class SqliteDriver extends BaseDriver {
  constructor() {
    super('sqlite');
    this._db = null;
    this._dbPath = null;
  }

  async connect(profile) {
    const { database } = profile || {};
    if (!database || typeof database !== 'string') {
      throw new RiduDBError({
        code: DRIVER_CODES.VALIDATION_ERROR,
        message: 'SQLite requires a database file path',
        driver: 'sqlite',
      });
    }

    const dbPath = path.resolve(database);

    try {
      fs.accessSync(dbPath, fs.constants.R_OK);
    } catch (err) {
      throw new RiduDBError({
        code: DRIVER_CODES.CONNECTION_FAILED,
        message: `SQLite database not found or not readable: ${dbPath}`,
        driver: 'sqlite',
        original: err,
      });
    }

    let SQL;
    try {
      SQL = await ensureSql();
    } catch (err) {
      throw normalizeDriverError(err, 'sqlite');
    }

    let db;
    try {
      // Load the file into memory as a read-only copy. Writes would not persist
      // to disk anyway, so this guarantees no destructive SQL can alter the file.
      const buf = fs.readFileSync(dbPath);
      db = new SQL.Database(buf);
    } catch (err) {
      throw normalizeDriverError(err, 'sqlite');
    }

    this._db = db;
    this._dbPath = dbPath;
    this._connected = true;
    this._connection = db;

    return {
      connectionId: `sqlite:${dbPath}:${Date.now()}:${Math.random()
        .toString(36)
        .slice(2)}`,
      engine: 'sqlite',
      database: dbPath,
    };
  }

  async disconnect() {
    try {
      if (this._db) {
        this._db.close();
      }
    } catch (err) {
      // close errors are non-fatal.
    } finally {
      this._connected = false;
      this._connection = null;
      this._db = null;
      this._dbPath = null;
    }
  }

  async listTables() {
    this._requireConnected();
    try {
      // sqlite_master is universally supported; pragma_table_list (3.37+) is not
      // available in all SQLite builds, so we use the stable fallback directly.
      const rows = this._all(
        this._db.prepare(
          "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'"
        ),
        []
      );
      return {
        tables: rows.map((r) => ({
          name: r.name,
          type: r.type === 'table' ? 'table' : 'view',
        })),
      };
    } catch (err) {
      throw normalizeDriverError(err, 'sqlite');
    }
  }

  async listColumns(tableName) {
    this._requireConnected();
    this._validateIdent(tableName);
    try {
      // PRAGMA table_info returns columns; table name must be interpolated
      // (identifiers cannot be parameterized) but is validated above.
      const rows = this._all(
        this._db.prepare(`PRAGMA table_info("${this._escapeIdent(tableName)}")`),
        []
      );
      // PRAGMA table_info returns an empty set for a nonexistent table rather
      // than throwing, so surface a clear "table not found" error.
      if (rows.length === 0) {
        throw new RiduDBError({
          code: DRIVER_CODES.INVALID_SQL,
          message: `Table not found: ${tableName}`,
          driver: 'sqlite',
        });
      }
      return {
        columns: rows.map((r) => ({
          name: r.name,
          dataType: r.type || 'TEXT',
          isNullable: r.notnull === 0,
          defaultValue: r.dflt_value === undefined ? null : r.dflt_value,
          maxLength: null,
          primaryKey: r.pk > 0,
        })),
      };
    } catch (err) {
      throw normalizeDriverError(err, 'sqlite');
    }
  }

  async executeQuery({ sql, params = [], limit = 1000 } = {}) {
    this._requireConnected();
    const validation = this.validateSql(sql);
    if (!validation.ok) {
      throw new RiduDBError({
        code: DRIVER_CODES.INVALID_SQL,
        message: validation.reason,
        driver: 'sqlite',
      });
    }

    const start = Date.now();
    try {
      const boundedSql = this._appendLimit(sql, limit);
      const stmt = this._db.prepare(boundedSql);
      const objRows = this._all(stmt, params);
      const columns = this._extractColumns(stmt);
      stmt.free();
      // Contract: rows are arrays of column values in column order.
      const rows = objRows.map((r) => columns.map((c) => r[c.name]));
      const truncated = rows.length === limit;

      return this.buildResult({
        columns,
        rows,
        truncated,
        durationMs: Date.now() - start,
      });
    } catch (err) {
      throw normalizeDriverError(err, 'sqlite');
    }
  }

  async cancelQuery() {
    // sql.js executes synchronously and results are bounded by `limit`, so there
    // is no long-running query to cancel.
    return { ok: true };
  }

  // Execute a prepared statement with optional params and return all rows as
  // objects keyed by column name. sql.js Statement.bind() accepts a single
  // array argument for the parameter values.
  _all(stmt, params = []) {
    if (params && params.length) {
      stmt.bind(params);
    }
    const cols = stmt.getColumnNames();
    const rows = [];
    while (stmt.step()) {
      const row = stmt.get();
      const obj = {};
      for (let i = 0; i < cols.length; i++) {
        obj[cols[i]] = row[i];
      }
      rows.push(obj);
    }
    stmt.reset();
    return rows;
  }

  _requireConnected() {
    if (!this._connected || !this._db) {
      throw new RiduDBError({
        code: DRIVER_CODES.CONNECTION_CLOSED,
        message: 'SQLite connection is closed',
        driver: 'sqlite',
      });
    }
  }

  _appendLimit(sql, limit) {
    const trimmed = sql.trim().replace(/;\s*$/, '');
    const upper = trimmed.toUpperCase();
    if (/\bLIMIT\b\s*\d/i.test(upper) || /\bFETCH\b/i.test(upper)) {
      return trimmed;
    }
    if (upper.startsWith('SELECT') || upper.startsWith('WITH')) {
      return `${trimmed} LIMIT ${Math.floor(limit)}`;
    }
    return trimmed;
  }

  _extractColumns(stmt) {
    let names = [];
    if (typeof stmt.getColumnNames === 'function') {
      names = stmt.getColumnNames();
    } else if (Array.isArray(stmt.columns)) {
      names = stmt.columns.map((c) => (typeof c === 'string' ? c : c.name));
    }
    return names.map((name) => ({ name, dataType: 'unknown' }));
  }

  _validateIdent(ident) {
    if (!ident || typeof ident !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) {
      throw new RiduDBError({
        code: DRIVER_CODES.INVALID_SQL,
        message: 'Invalid table identifier',
        driver: 'sqlite',
      });
    }
  }

  _escapeIdent(ident) {
    return String(ident).replace(/"/g, '""');
  }
}

module.exports = SqliteDriver;
