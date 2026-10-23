/**
 * Integration tests for the RiduDB Studio SQLite vertical slice.
 *
 * These tests exercise the full read-only query path through the backend
 * ConnectionManager (the same API used by the Electron main process IPC
 * handlers). They use a temporary SQLite database on disk and never touch
 * production credentials.
 *
 * Covered:
 *  1. Profile validation (valid + invalid profiles)
 *  2. Connect to a real SQLite test database
 *  3. Inspect tables and columns
 *  4. Execute read-only SQL query (column names, rows, status)
 *  5. NULL values preserved
 *  6. Empty results
 *  7. Invalid SQL (no crash, typed error)
 *  8. Destructive SQL rejected
 *  9. Parameterized queries
 * 10. Disconnected / closed connection (CONNECTION_CLOSED)
 * 11. Missing SQLite file (CONNECTION_FAILED)
 */

// Backend is CommonJS without declaration files; use require.
const {
  validate,
  connect,
  disconnect,
  listConnections,
  listTables,
  listColumns,
  executeQuery,
} = require('../../backend/src/index');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

let dbPath: string;
let tmpDir: string;
let connectionId: string;

beforeAll(() => {
  // Build a temporary SQLite test database.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ridudb-integration-'));
  dbPath = path.join(tmpDir, 'test.db');
  execSync(
    `sqlite3 "${dbPath}" "CREATE TABLE employees (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, department TEXT, salary REAL); CREATE TABLE departments (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE empty_table (id INTEGER); INSERT INTO employees VALUES (1,'Alice','alice@example.com','Engineering',95000); INSERT INTO employees VALUES (2,'Bob',NULL,'Engineering',NULL); INSERT INTO employees VALUES (3,'Carol','carol@example.com','Marketing',80000); INSERT INTO departments VALUES (1,'Engineering'); INSERT INTO departments VALUES (2,'Marketing');"`,
  );
});

afterAll(() => {
  // Clean up temp directory.
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('SQLite vertical slice (backend ConnectionManager)', () => {
  describe('1. Profile validation', () => {
    test('valid sqlite profile passes', async () => {
      const result = await validate({ name: 'Test', engine: 'sqlite', database: dbPath });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    test('empty profile rejected', async () => {
      const result = await validate({ name: '', engine: 'sqlite', database: '' });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    test('sqlite missing database rejected', async () => {
      const result = await validate({ name: 'x', engine: 'sqlite' });
      expect(result.valid).toBe(false);
    });

    test('invalid engine rejected', async () => {
      const result = await validate({ name: 'x', engine: 'nope', database: dbPath });
      expect(result.valid).toBe(false);
    });

    test('postgres port out of range rejected', async () => {
      const result = await validate({ name: 'pg', engine: 'postgres', host: 'localhost', database: 'db', port: 99999 });
      expect(result.valid).toBe(false);
    });
  });

  describe('2. Connect to SQLite', () => {
    test('connects and returns connectionId, engine, database', async () => {
      const result = await connect({ name: 'Test SQLite', engine: 'sqlite', database: dbPath });
      expect(result.engine).toBe('sqlite');
      expect(typeof result.connectionId).toBe('string');
      expect(result.connectionId.length).toBeGreaterThan(0);
      expect(result.database).toBe(dbPath);
      connectionId = result.connectionId;
    });

    test('connection is registered in listConnections', async () => {
      const list = listConnections();
      expect(list.connections.length).toBeGreaterThan(0);
      expect(list.connections.some((c: any) => c.connectionId === connectionId)).toBe(true);
    });
  });

  describe('3. Inspect tables', () => {
    beforeEach(async () => {
      const result = await connect({ name: 'Test', engine: 'sqlite', database: dbPath });
      connectionId = result.connectionId;
    });

    afterEach(async () => {
      await disconnect(connectionId);
    });

    test('lists tables excluding internal sqlite tables', async () => {
      const tables = await listTables(connectionId);
      const names = tables.tables.map((t: any) => t.name).sort();
      expect(names).toContain('employees');
      expect(names).toContain('departments');
      expect(names).toContain('empty_table');
      expect(names.some((n: string) => n.startsWith('sqlite_'))).toBe(false);
    });

    test('table type is correct', async () => {
      const tables = await listTables(connectionId);
      const emp = tables.tables.find((t: any) => t.name === 'employees');
      expect(emp.type).toBe('table');
    });
  });

  describe('4. Inspect columns', () => {
    beforeEach(async () => {
      const result = await connect({ name: 'Test', engine: 'sqlite', database: dbPath });
      connectionId = result.connectionId;
    });

    afterEach(async () => {
      await disconnect(connectionId);
    });

    test('returns column names and nullability', async () => {
      const cols = await listColumns(connectionId, 'employees');
      const colNames = cols.columns.map((c: any) => c.name);
      expect(colNames).toContain('id');
      expect(colNames).toContain('name');
      expect(colNames).toContain('email');
      expect(colNames).toContain('department');
      expect(colNames).toContain('salary');

      const emailCol = cols.columns.find((c: any) => c.name === 'email');
      expect(emailCol.isNullable).toBe(true);

      const nameCol = cols.columns.find((c: any) => c.name === 'name');
      expect(nameCol.isNullable).toBe(false);
    });

    test('nonexistent table throws typed error', async () => {
      await expect(listColumns(connectionId, 'does_not_exist')).rejects.toMatchObject({
        code: expect.any(String),
      });
    });
  });

  describe('5. Execute read-only query', () => {
    beforeEach(async () => {
      const result = await connect({ name: 'Test', engine: 'sqlite', database: dbPath });
      connectionId = result.connectionId;
    });

    afterEach(async () => {
      await disconnect(connectionId);
    });

    test('returns columns, rows, and status ok', async () => {
      const result = await executeQuery(connectionId, {
        sql: 'SELECT id, name, department FROM employees ORDER BY id',
        limit: 100,
      });
      expect(result.status).toBe('ok');
      expect(result.rowCount).toBe(3);
      expect(result.columns.length).toBe(3);
      expect(result.columns[0].name).toBe('id');
      expect(result.columns[1].name).toBe('name');
      expect(result.columns[2].name).toBe('department');
      expect(result.rows[0][0]).toBe(1);
      expect(result.rows[0][1]).toBe('Alice');
      expect(result.truncated).toBe(false);
    });

    test('bounded result set (limit)', async () => {
      const result = await executeQuery(connectionId, {
        sql: 'SELECT id FROM employees',
        limit: 2,
      });
      expect(result.rowCount).toBeLessThanOrEqual(2);
    });
  });

  describe('6. NULL values', () => {
    beforeEach(async () => {
      const result = await connect({ name: 'Test', engine: 'sqlite', database: dbPath });
      connectionId = result.connectionId;
    });

    afterEach(async () => {
      await disconnect(connectionId);
    });

    test('NULL values are preserved as null', async () => {
      const result = await executeQuery(connectionId, {
        sql: 'SELECT id, name, email, salary FROM employees WHERE id = 2',
        limit: 100,
      });
      expect(result.status).toBe('ok');
      expect(result.rowCount).toBe(1);
      expect(result.rows[0][1]).toBe('Bob');
      expect(result.rows[0][2]).toBeNull();
      expect(result.rows[0][3]).toBeNull();
    });
  });

  describe('7. Empty results', () => {
    beforeEach(async () => {
      const result = await connect({ name: 'Test', engine: 'sqlite', database: dbPath });
      connectionId = result.connectionId;
    });

    afterEach(async () => {
      await disconnect(connectionId);
    });

    test('returns empty rows array with rowCount 0', async () => {
      const result = await executeQuery(connectionId, {
        sql: 'SELECT id, name FROM employees WHERE id = -1',
        limit: 100,
      });
      expect(result.status).toBe('ok');
      expect(result.rowCount).toBe(0);
      expect(result.rows).toEqual([]);
    });
  });

  describe('8. Invalid SQL', () => {
    beforeEach(async () => {
      const result = await connect({ name: 'Test', engine: 'sqlite', database: dbPath });
      connectionId = result.connectionId;
    });

    afterEach(async () => {
      await disconnect(connectionId);
    });

    test('nonexistent table throws typed error (no crash)', async () => {
      await expect(
        executeQuery(connectionId, { sql: 'SELECT * FROM nonexistent_table', limit: 100 }),
      ).rejects.toMatchObject({ code: expect.any(String) });
    });

    test('empty SQL is rejected', async () => {
      await expect(
        executeQuery(connectionId, { sql: '', limit: 100 }),
      ).rejects.toMatchObject({ code: expect.any(String) });
    });

    test('DELETE is rejected as INVALID_SQL', async () => {
      await expect(
        executeQuery(connectionId, { sql: 'DELETE FROM employees', limit: 100 }),
      ).rejects.toMatchObject({ code: 'INVALID_SQL' });
    });

    test('DROP is rejected as INVALID_SQL', async () => {
      await expect(
        executeQuery(connectionId, { sql: 'DROP TABLE employees', limit: 100 }),
      ).rejects.toMatchObject({ code: 'INVALID_SQL' });
    });
  });

  describe('9. Parameterized queries', () => {
    beforeEach(async () => {
      const result = await connect({ name: 'Test', engine: 'sqlite', database: dbPath });
      connectionId = result.connectionId;
    });

    afterEach(async () => {
      await disconnect(connectionId);
    });

    test('supports ? parameters safely', async () => {
      const result = await executeQuery(connectionId, {
        sql: 'SELECT name, salary FROM employees WHERE department = ?',
        params: ['Engineering'],
        limit: 100,
      });
      expect(result.status).toBe('ok');
      expect(result.rowCount).toBe(2);
      const names = result.rows.map((r: any[]) => r[0]).sort();
      expect(names).toEqual(['Alice', 'Bob']);
    });
  });

  describe('10. Disconnected database', () => {
    test('query on closed connection throws CONNECTION_CLOSED', async () => {
      const result = await connect({ name: 'Test', engine: 'sqlite', database: dbPath });
      await disconnect(result.connectionId);

      await expect(
        executeQuery(result.connectionId, { sql: 'SELECT 1', limit: 100 }),
      ).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
    });

    test('connecting to nonexistent file throws CONNECTION_FAILED', async () => {
      await expect(
        connect({ name: 'bad', engine: 'sqlite', database: '/tmp/ridudb-does-not-exist.db' }),
      ).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
    });
  });
});
