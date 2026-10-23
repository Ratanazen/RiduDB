'use strict';

const { Client } = require('pg');
const { BaseDriver } = require('./base');
const { RiduDBError, DRIVER_CODES, normalizeDriverError } = require('../errors');

class PostgresDriver extends BaseDriver {
  constructor() {
    super('postgres');
    this._client = null;
    this._queryCancellationPid = null;
  }

  async connect(profile) {
    const {
      host = 'localhost',
      port = 5432,
      database,
      username,
      password,
      ssl = false,
      connectTimeoutMs = 10000,
    } = profile || {};

    if (!database) {
      throw new RiduDBError({
        code: DRIVER_CODES.VALIDATION_ERROR,
        message: 'PostgreSQL requires a database name',
        driver: 'postgres',
      });
    }

    const client = new Client({
      host,
      port,
      database,
      user: username,
      password,
      ssl,
      connectionTimeoutMillis: connectTimeoutMs,
    });

    try {
      await client.connect();
    } catch (err) {
      throw normalizeDriverError(err, 'postgres');
    }

    this._client = client;
    this._connected = true;
    this._connection = client;

    // Capture the backend PID so pg_cancel_backend can target this session.
    try {
      const pidRes = await client.query('SELECT pg_backend_pid() AS pid');
      this._queryCancellationPid = pidRes.rows[0]?.pid ?? null;
    } catch {
      // Best effort; cancelQuery will return ok: false if PID is unavailable.
    }

    return {
      connectionId: `postgres:${host}:${port}/${database}:${Date.now()}`,
      engine: 'postgres',
      database,
    };
  }

  async disconnect() {
    try {
      if (this._client) {
        await this._client.end();
      }
    } catch (err) {
      // end() errors are non-fatal.
    } finally {
      this._connected = false;
      this._client = null;
      this._connection = null;
      this._queryCancellationPid = null;
    }
  }

  async listTables() {
    this._requireConnected();
    try {
      const res = await this._client.query(
        `SELECT table_name AS name, table_type AS type
         FROM information_schema.tables
         WHERE table_schema NOT IN ('pg_catalog','information_schema')
         ORDER BY table_name`
      );
      return {
        tables: res.rows.map((r) => ({
          name: r.name,
          type: r.type === 'BASE TABLE' ? 'table' : 'view',
        })),
      };
    } catch (err) {
      throw normalizeDriverError(err, 'postgres');
    }
  }

  async listColumns(tableName) {
    this._requireConnected();
    this._validateIdent(tableName);
    try {
      const res = await this._client.query(
        `SELECT column_name AS name,
                data_type AS data_type,
                is_nullable AS is_nullable,
                column_default AS default_value,
                character_maximum_length AS max_length
         FROM information_schema.columns
         WHERE table_name = $1
         ORDER BY ordinal_position`,
        [tableName]
      );
      const columns = res.rows.map((r) => ({
        name: r.name,
        dataType: r.data_type || 'unknown',
        isNullable: r.is_nullable === 'YES',
        defaultValue: r.default_value === undefined ? null : r.default_value,
        maxLength: r.max_length === null ? null : Number(r.max_length),
      }));
      // information_schema returns empty for a nonexistent table rather than
      // throwing, so surface a clear "table not found" error.
      if (columns.length === 0) {
        throw new RiduDBError({
          code: DRIVER_CODES.INVALID_SQL,
          message: `Table not found: ${tableName}`,
          driver: 'postgres',
        });
      }
      return { columns };
    } catch (err) {
      throw normalizeDriverError(err, 'postgres');
    }
  }

  async executeQuery({ sql, params = [], limit = 1000 } = {}) {
    this._requireConnected();
    const validation = this.validateSql(sql);
    if (!validation.ok) {
      throw new RiduDBError({
        code: DRIVER_CODES.INVALID_SQL,
        message: validation.reason,
        driver: 'postgres',
      });
    }

    const start = Date.now();
    try {
      // PostgreSQL uses $1, $2, ... parameter placeholders. Convert `?` placeholders
      // (used by callers) to $n for safety and consistency.
      const { sql: pgSql, values } = this._convertPlaceholders(sql, params);
      const bounded = this._appendLimit(pgSql, limit);

      const res = await this._client.query(bounded, values);
      const columns = this._extractColumns(res.fields);
      const truncated = res.rowCount === limit;

      return this.buildResult({
        columns,
        rows: res.rows.map((r) => Object.values(r)),
        truncated,
        durationMs: Date.now() - start,
      });
    } catch (err) {
      // Handle statement cancellation explicitly.
      if (err.code === '57014') {
        throw new RiduDBError({
          code: DRIVER_CODES.QUERY_CANCELLED,
          message: 'Query was cancelled',
          driver: 'postgres',
          original: err,
        });
      }
      if (err.code === '57015') {
        throw new RiduDBError({
          code: DRIVER_CODES.QUERY_TIMEOUT,
          message: 'Query timed out',
          driver: 'postgres',
          original: err,
        });
      }
      throw normalizeDriverError(err, 'postgres');
    }
  }

  async cancelQuery() {
    if (!this._client || !this._queryCancellationPid) {
      return { ok: false };
    }
    try {
      await this._client.query(
        'SELECT pg_cancel_backend($1)',
        [this._queryCancellationPid]
      );
      return { ok: true };
    } catch (err) {
      return { ok: false };
    }
  }

  _requireConnected() {
    if (!this._connected || !this._client) {
      throw new RiduDBError({
        code: DRIVER_CODES.CONNECTION_CLOSED,
        message: 'PostgreSQL connection is closed',
        driver: 'postgres',
      });
    }
  }

  // Convert `?` placeholders to `$1`, `$2`, ... and collect values.
  _convertPlaceholders(sql, params) {
    const values = [...params];
    let index = 1;
    const pgSql = sql.replace(/\?/g, () => `$${index++}`);
    return { sql: pgSql, values };
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

  _extractColumns(fields) {
    return (fields || []).map((f) => ({
      name: f.name,
      dataType: f.dataTypeID ? String(f.dataTypeID) : 'unknown',
    }));
  }

  _validateIdent(ident) {
    if (!ident || typeof ident !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) {
      throw new RiduDBError({
        code: DRIVER_CODES.INVALID_SQL,
        message: 'Invalid table identifier',
        driver: 'postgres',
      });
    }
  }
}

module.exports = PostgresDriver;
