'use strict';

const mysql = require('mysql2/promise');
const { BaseDriver } = require('./base');
const { RiduDBError, DRIVER_CODES, normalizeDriverError } = require('../errors');

class MysqlDriver extends BaseDriver {
  constructor() {
    super('mysql');
    this._connection = null;
  }

  async connect(profile) {
    const {
      host = 'localhost',
      port = 3306,
      database,
      username,
      password,
      ssl = false,
      connectTimeout = 10000,
    } = profile || {};

    if (!database) {
      throw new RiduDBError({
        code: DRIVER_CODES.VALIDATION_ERROR,
        message: 'MySQL requires a database name',
        driver: 'mysql',
      });
    }

    let conn;
    try {
      conn = await mysql.createConnection({
        host,
        port,
        database,
        user: username,
        password,
        ssl,
        connectTimeout,
        // Prevent local-infile and multiple statements for safety.
        insecureAuth: false,
        multipleStatements: false,
      });
    } catch (err) {
      throw normalizeDriverError(err, 'mysql');
    }

    this._connection = conn;
    this._connected = true;

    return {
      connectionId: `mysql:${host}:${port}/${database}:${Date.now()}`,
      engine: 'mysql',
      database,
    };
  }

  async disconnect() {
    try {
      if (this._connection) {
        await this._connection.end();
      }
    } catch (err) {
      // end() errors are non-fatal.
    } finally {
      this._connected = false;
      this._connection = null;
    }
  }

  async listTables() {
    this._requireConnected();
    try {
      const [rows] = await this._connection.query(
        `SELECT table_name AS name, table_type AS type
         FROM information_schema.tables
         WHERE table_schema = DATABASE()
         ORDER BY table_name`
      );
      return {
        tables: rows.map((r) => ({
          name: r.name,
          type: r.type === 'BASE TABLE' ? 'table' : 'view',
        })),
      };
    } catch (err) {
      throw normalizeDriverError(err, 'mysql');
    }
  }

  async listColumns(tableName) {
    this._requireConnected();
    this._validateIdent(tableName);
    try {
      // DESCRIBE is read-only and safe for introspection.
      const [rows] = await this._connection.query(`DESCRIBE \`${this._escapeIdent(tableName)}\``);
      return {
        columns: rows.map((r) => ({
          name: r.Field,
          dataType: r.Type || 'unknown',
          isNullable: r.Null === 'YES',
          defaultValue: r.Default === undefined ? null : r.Default,
          maxLength: null,
        })),
      };
    } catch (err) {
      throw normalizeDriverError(err, 'mysql');
    }
  }

  async executeQuery({ sql, params = [], limit = 1000 } = {}) {
    this._requireConnected();
    const validation = this.validateSql(sql);
    if (!validation.ok) {
      throw new RiduDBError({
        code: DRIVER_CODES.INVALID_SQL,
        message: validation.reason,
        driver: 'mysql',
      });
    }

    const start = Date.now();
    try {
      const bounded = this._appendLimit(sql, limit);
      // mysql2 uses `?` placeholders natively; params passed safely (parameterized).
      const [rows] = await this._connection.query(bounded, params);
      const fields = this._extractFields(rows);
      const columns = fields.map((f) => ({ name: f.name, dataType: f.type || 'unknown' }));
      const truncated = rows.length === limit;

      return this.buildResult({
        columns,
        rows: rows.map((r) => Object.values(r)),
        truncated,
        durationMs: Date.now() - start,
      });
    } catch (err) {
      // ER_QUERY_INTERRUPTED / ER_LOCK_WAIT_TIMEOUT etc.
      const code = err.code || err.errno;
      if (code === 'ER_QUERY_INTERRUPTED') {
        throw new RiduDBError({
          code: DRIVER_CODES.QUERY_CANCELLED,
          message: 'Query was cancelled',
          driver: 'mysql',
          original: err,
        });
      }
      throw normalizeDriverError(err, 'mysql');
    }
  }

  async cancelQuery() {
    // MySQL: kill the current connection's running query via KILL QUERY on the
    // connection thread id. Best effort.
    if (!this._connection) return { ok: false };
    try {
      const threadId = this._connection.threadId;
      await this._connection.query(`KILL QUERY ${threadId}`);
      return { ok: true };
    } catch (err) {
      return { ok: false };
    }
  }

  _requireConnected() {
    if (!this._connected || !this._connection) {
      throw new RiduDBError({
        code: DRIVER_CODES.CONNECTION_CLOSED,
        message: 'MySQL connection is closed',
        driver: 'mysql',
      });
    }
  }

  _appendLimit(sql, limit) {
    const trimmed = sql.trim().replace(/;\s*$/, '');
    const upper = trimmed.toUpperCase();
    if (/\bLIMIT\b\s*\d/i.test(upper)) return trimmed;
    if (upper.startsWith('SELECT')) {
      return `${trimmed} LIMIT ${Math.floor(limit)}`;
    }
    return trimmed;
  }

  _extractFields(rows) {
    // mysql2 query result rows do not carry field metadata directly; re-query
    // field info via the statement is complex. We return column names from the
    // first row keys instead (driver metadata not exposed on rows array).
    if (!rows || rows.length === 0) return [];
    return Object.keys(rows[0]).map((name) => ({ name }));
  }

  _validateIdent(ident) {
    if (!ident || typeof ident !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) {
      throw new RiduDBError({
        code: DRIVER_CODES.INVALID_SQL,
        message: 'Invalid table identifier',
        driver: 'mysql',
      });
    }
  }

  _escapeIdent(ident) {
    return String(ident).replace(/`/g, '``');
  }
}

module.exports = MysqlDriver;
