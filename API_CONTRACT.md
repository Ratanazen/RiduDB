# RiduDB Studio — Backend API Contract

This file defines the shared interface between the database backend (this agent,
DeepSeek) and the frontend/UI agent(s). Do not change these signatures without
coordinating with the team.

## Module entry point

`backend/src/index.js` exports a single object with these methods. All methods
are asynchronous and return plain objects (JSON-serializable results). Driver
errors are surfaced as typed `RiduDBError` objects (see `src/errors.js`).

## Connection profiles

A connection profile is a plain object:

```js
{
  id: string,              // optional client-generated id
  name: string,            // display name
  engine: 'sqlite' | 'postgres' | 'mysql',
  host?: string,           // postgres/mysql only
  port?: number,           // postgres/mysql only
  database: string,        // sqlite: path to .db file; pg/mysql: db name
  username?: string,       // pg/mysql only
  password?: string,       // pg/mysql only - NEVER logged
  ssl?: boolean,           // pg/mysql only
  connectTimeoutMs?: number,
}
```

Passwords are held in memory only for the lifetime of a connection and are never
written to logs or source control.

## API

### validate(profile) -> { valid: boolean, errors: string[] }

Client-side profile validation without opening a connection. Checks required
fields and port ranges. Never touches the network or disk (except sqlite file
existence when a path is given).

### connect(profile) -> { connectionId: string, engine: string, database: string }

Open a connection and register it under `connectionId`. Returns immediately.
Throws a typed `RiduDBError` on failure (invalid credentials, unreachable host,
missing sqlite file, etc.).

### disconnect(connectionId) -> { ok: boolean }

Close and unregister a connection. Idempotent.

### listConnections() -> { connections: Array<{connectionId, engine, database}> }

List active connections.

### listTables(connectionId) -> { tables: Array<{name, type}> }

Inspect tables (and views) in the current database.

### listColumns(connectionId, tableName) -> { columns: Array<{name, dataType, isNullable, defaultValue, maxLength}> }

Inspect columns of a single table.

### executeQuery(connectionId, { sql, params, limit }) -> ExecutionResult

Execute a read-only SQL query. `params` supports parameterized queries for
application-generated data. `limit` bounds the result set (default 1000).

```ts
interface ExecutionResult {
  status: 'ok' | 'error';
  columns: Array<{name, dataType}>;   // column names + types
  rows: Array<Array<any>>;             // row data (nulls preserved)
  rowCount: number;                    // rows returned
  truncated: boolean;                  // true if result hit the limit
  durationMs: number;
  error?: { code, message };           // present when status === 'error'
}
```

- Invalid SQL -> `status: 'error'` with a driver error message (no crash).
- Empty result -> `rows: []`, `rowCount: 0`, `status: 'ok'`.
- NULL values -> `null` entries in rows (never omitted or coerced).
- Disconnected / closed connection -> typed `RiduDBError` (`CONNECTION_CLOSED`).

### cancelQuery(queryId) -> { ok: boolean }

Cancel a running query where the driver supports it (postgres/mysql). SQLite
queries are short and bounded by `limit`, so cancellation is a no-op returning
`ok: true`.

## Errors

All driver errors are normalized to `RiduDBError` with:
- `name: 'RiduDBError'`
- `code`: `CONNECTION_FAILED`, `CONNECTION_CLOSED`, `INVALID_SQL`, `QUERY_CANCELLED`,
  `QUERY_TIMEOUT`, `RESULT_TRUNCATED`, `DRIVER_ERROR`, `VALIDATION_ERROR`
- `message`: human-readable, no credentials
- `driver`: `'sqlite' | 'postgres' | 'mysql' | 'base'`
- `original`: the raw driver error (for debugging, never logged with secrets)

## Security rules (backend)

1. Never log `profile.password` or any connection string containing credentials.
2. Only read-only SQL (`SELECT`, `PRAGMA`, `SHOW`, `DESCRIBE`, `EXPLAIN`) is
   permitted through `executeQuery`. Destructive statements are rejected.
3. Parameterized queries are used for all application-generated parameters.
4. Result sets are bounded by `limit` (default 1000 rows).
5. Connections are closed on process exit.
