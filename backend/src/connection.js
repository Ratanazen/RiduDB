'use strict';

const SqliteDriver = require('./drivers/sqlite');
const PostgresDriver = require('./drivers/postgres');
const MysqlDriver = require('./drivers/mysql');
const { RiduDBError, DRIVER_CODES } = require('./errors');

const DRIVER_BY_ENGINE = {
  sqlite: SqliteDriver,
  postgres: PostgresDriver,
  mysql: MysqlDriver,
};

class ConnectionManager {
  constructor() {
    this._connections = new Map(); // connectionId -> { driver, profile, createdAt }
  }

  // Validate a profile without opening a connection. Never touches network/disk
  // except checking sqlite file existence.
  validate(profile) {
    const errors = [];
    if (!profile || typeof profile !== 'object') {
      return { valid: false, errors: ['Profile is required'] };
    }
    const { name, engine, database, host, port } = profile;

    if (!name || typeof name !== 'string' || !name.trim()) {
      errors.push('Connection name is required');
    }
    if (!engine || !DRIVER_BY_ENGINE[engine]) {
      errors.push(`Invalid engine: ${engine}. Expected sqlite, postgres, or mysql`);
    } else if (engine === 'sqlite') {
      if (!database || typeof database !== 'string' || !database.trim()) {
        errors.push('SQLite requires a database file path');
      }
    } else {
      // postgres / mysql
      if (!database || typeof database !== 'string' || !database.trim()) {
        errors.push(`${engine} requires a database name`);
      }
      if (!host || typeof host !== 'string' || !host.trim()) {
        errors.push(`${engine} requires a host`);
      }
      if (port !== undefined) {
        const p = Number(port);
        if (!Number.isInteger(p) || p < 1 || p > 65535) {
          errors.push(`${engine} port must be between 1 and 65535`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  // Open a connection and register it.
  async connect(profile) {
    const validation = this.validate(profile);
    if (!validation.valid) {
      throw new RiduDBError({
        code: DRIVER_CODES.VALIDATION_ERROR,
        message: validation.errors.join('; '),
        driver: 'base',
      });
    }

    const DriverCls = DRIVER_BY_ENGINE[profile.engine];
    const driver = new DriverCls();
    const info = await driver.connect(profile);

    const connectionId = info.connectionId;
    this._connections.set(connectionId, {
      driver,
      profile: { ...profile },
      createdAt: Date.now(),
    });

    // Do not log the profile (contains passwords). Log only safe fields.
    // console.log('connected', connectionId, profile.engine);

    return {
      connectionId,
      engine: profile.engine,
      database: profile.database,
    };
  }

  async disconnect(connectionId) {
    const entry = this._connections.get(connectionId);
    if (!entry) return { ok: false };
    try {
      await entry.driver.disconnect();
    } catch (err) {
      // best effort
    }
    this._connections.delete(connectionId);
    return { ok: true };
  }

  listConnections() {
    return {
      connections: [...this._connections.entries()].map(
        ([connectionId, entry]) => ({
          connectionId,
          engine: entry.driver.engine,
          database: entry.profile.database,
        })
      ),
    };
  }

  getDriver(connectionId) {
    const entry = this._connections.get(connectionId);
    if (!entry) {
      throw new RiduDBError({
        code: DRIVER_CODES.CONNECTION_CLOSED,
        message: `No active connection: ${connectionId}`,
        driver: 'base',
      });
    }
    return entry.driver;
  }

  // Delegate schema/query calls to the driver.
  async listTables(connectionId) {
    return this.getDriver(connectionId).listTables();
  }

  async listColumns(connectionId, tableName) {
    return this.getDriver(connectionId).listColumns(tableName);
  }

  async executeQuery(connectionId, params) {
    return this.getDriver(connectionId).executeQuery(params);
  }

  async cancelQuery(connectionId) {
    return this.getDriver(connectionId).cancelQuery();
  }

  async closeAll() {
    const ids = [...this._connections.keys()];
    for (const id of ids) {
      await this.disconnect(id);
    }
  }
}

module.exports = { ConnectionManager };
