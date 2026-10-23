#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

// ---- Backend under test ----
const {
  validate,
  connect,
  disconnect,
  listConnections,
  listTables,
  listColumns,
  executeQuery,
  cancelQuery,
} = require('../src/index');

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(message);
    console.error(`  FAIL: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
  } else {
    failed++;
    failures.push(`${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    console.error(`  FAIL: ${message}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
  }
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

async function run() {
  // ---- Build a temporary SQLite test database ----
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ridudb-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  execSync(`sqlite3 "${dbPath}" "CREATE TABLE employees (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, department TEXT, salary REAL); INSERT INTO employees VALUES (1,'Alice','alice@example.com','Engineering',95000); INSERT INTO employees VALUES (2,'Bob',NULL,'Engineering',NULL); INSERT INTO employees VALUES (3,'Carol','carol@example.com','Marketing',80000); CREATE TABLE departments (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO departments VALUES (1,'Engineering'); INSERT INTO departments VALUES (2,'Marketing'); CREATE TABLE empty_table (id INTEGER);"`);
  console.log(`Test DB created at ${dbPath}`);

  // ---- 1. Profile validation ----
  section('Profile validation');
  const validProfile = { name: 'Test SQLite', engine: 'sqlite', database: dbPath };
  const v1 = await validate(validProfile);
  assert(v1.valid === true, 'valid sqlite profile passes');
  assert(JSON.stringify(v1.errors) === '[]', 'no errors for valid profile');

  const v2 = await validate({ name: '', engine: 'sqlite', database: '' });
  assert(v2.valid === false, 'empty profile rejected');
  assert(v2.errors.length > 0, 'errors reported for empty profile');

  const v3 = await validate({ name: 'x', engine: 'sqlite' });
  assert(v3.valid === false, 'sqlite missing database rejected');

  const v4 = await validate({ name: 'x', engine: 'nope', database: dbPath });
  assert(v4.valid === false, 'invalid engine rejected');

  const v5 = await validate({ name: 'pg', engine: 'postgres', host: 'localhost', database: 'db', port: 99999 });
  assert(v5.valid === false, 'postgres port out of range rejected');

  // ---- 2. Connect to real SQLite test database ----
  section('Connect to SQLite');
  const conn = await connect(validProfile);
  assert(conn.engine === 'sqlite', 'connection engine is sqlite');
  assert(typeof conn.connectionId === 'string' && conn.connectionId.length > 0, 'connectionId returned');
  assert(conn.database === dbPath, 'database path returned');

  const list = listConnections();
  assert(list.connections.length === 1, 'connection registered in listConnections');
  assert(list.connections[0].engine === 'sqlite', 'listConnections engine correct');

  // ---- 3. Inspect tables ----
  section('Inspect tables');
  const tables = await listTables(conn.connectionId);
  const tableNames = tables.tables.map((t) => t.name).sort();
  assert(tableNames.includes('employees'), 'employees table listed');
  assert(tableNames.includes('departments'), 'departments table listed');
  assert(tableNames.includes('empty_table'), 'empty_table listed');
  // sqlite internal tables should be excluded
  assert(!tableNames.some((n) => n.startsWith('sqlite_')), 'internal sqlite tables excluded');
  const emp = tables.tables.find((t) => t.name === 'employees');
  assert(emp.type === 'table', 'employees type is table');

  // ---- 4. Inspect columns ----
  section('Inspect columns');
  const cols = await listColumns(conn.connectionId, 'employees');
  const colNames = cols.columns.map((c) => c.name);
  assert(colNames.includes('id'), 'id column present');
  assert(colNames.includes('name'), 'name column present');
  assert(colNames.includes('email'), 'email column present');
  assert(colNames.includes('department'), 'department column present');
  assert(colNames.includes('salary'), 'salary column present');
  const emailCol = cols.columns.find((c) => c.name === 'email');
  assert(emailCol.isNullable === true, 'email column is nullable');
  const nameCol = cols.columns.find((c) => c.name === 'name');
  assert(nameCol.isNullable === false, 'name column is not nullable');

  // invalid table -> error
  try {
    await listColumns(conn.connectionId, 'does_not_exist');
    assert(false, 'nonexistent table should throw');
  } catch (err) {
    assert(err.code !== undefined, 'nonexistent table throws typed error');
  }

  // ---- 5. Execute read-only SQL query ----
  section('Execute read-only query');
  const q1 = await executeQuery(conn.connectionId, { sql: 'SELECT id, name, department FROM employees ORDER BY id' });
  assert(q1.status === 'ok', 'query status ok');
  assert(q1.rowCount === 3, '3 rows returned');
  assert(q1.columns.length === 3, '3 columns returned');
  assert(q1.columns[0].name === 'id', 'first column id');
  assert(q1.columns[1].name === 'name', 'second column name');
  assert(q1.rows[0][0] === 1 && q1.rows[0][1] === 'Alice', 'first row values');
  assert(!q1.truncated, 'not truncated');

  // ---- 6. NULL values ----
  section('NULL values');
  const q2 = await executeQuery(conn.connectionId, { sql: 'SELECT id, name, email, salary FROM employees WHERE id = 2' });
  assert(q2.status === 'ok', 'null query status ok');
  assert(q2.rowCount === 1, 'one row with nulls');
  assert(q2.rows[0][1] === 'Bob', 'Bob name present');
  assert(q2.rows[0][2] === null, 'email is null');
  assert(q2.rows[0][3] === null, 'salary is null');

  // ---- 7. Empty results ----
  section('Empty results');
  const q3 = await executeQuery(conn.connectionId, {
    sql: 'SELECT id, name FROM employees WHERE id = -1',
  });
  assert(q3.status === 'ok', 'empty result status ok');
  assert(q3.rowCount === 0, 'zero rows returned');
  assert(JSON.stringify(q3.rows) === '[]', 'empty rows array');

  // ---- 8. Invalid SQL ----
  section('Invalid SQL');
  try {
    await executeQuery(conn.connectionId, { sql: 'SELECT * FROM nonexistent_table' });
    assert(false, 'invalid sql should throw');
  } catch (err) {
    assert(err.code !== undefined, 'invalid sql throws typed error');
    assert(err.driver === 'sqlite', 'driver is sqlite');
  }

  // destructive SQL rejected
  try {
    await executeQuery(conn.connectionId, { sql: 'DELETE FROM employees' });
    assert(false, 'DELETE should be rejected');
  } catch (err) {
    assert(err.code === 'INVALID_SQL', 'DELETE rejected as INVALID_SQL');
  }
  try {
    await executeQuery(conn.connectionId, { sql: 'DROP TABLE employees' });
    assert(false, 'DROP should be rejected');
  } catch (err) {
    assert(err.code === 'INVALID_SQL', 'DROP rejected as INVALID_SQL');
  }
  try {
    await executeQuery(conn.connectionId, { sql: '' });
    assert(false, 'empty sql should be rejected');
  } catch (err) {
    assert(err.code === 'INVALID_SQL', 'empty sql rejected as INVALID_SQL');
  }

  // ---- 9. Parameterized query ----
  section('Parameterized query');
  const q4 = await executeQuery(conn.connectionId, {
    sql: 'SELECT name, salary FROM employees WHERE department = ?',
    params: ['Engineering'],
  });
  assert(q4.status === 'ok', 'parameterized query ok');
  assert(q4.rowCount === 2, '2 engineering employees');
  const names = q4.rows.map((r) => r[0]).sort();
  assert(names[0] === 'Alice' && names[1] === 'Bob', 'engineering names correct');

  // ---- 10. Disconnected database ----
  section('Disconnected database');
  await disconnect(conn.connectionId);
  const listAfter = listConnections();
  assert(listAfter.connections.length === 0, 'connection removed after disconnect');

  try {
    await executeQuery(conn.connectionId, { sql: 'SELECT 1' });
    assert(false, 'query on closed connection should throw');
  } catch (err) {
    assert(err.code === 'CONNECTION_CLOSED', 'closed connection throws CONNECTION_CLOSED');
  }

  // connecting to nonexistent sqlite file fails
  try {
    await connect({ name: 'bad', engine: 'sqlite', database: '/tmp/ridudb-does-not-exist.db' });
    assert(false, 'missing sqlite file should fail');
  } catch (err) {
    assert(err.code === 'CONNECTION_FAILED', 'missing file throws CONNECTION_FAILED');
  }

  // cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // ---- Summary ----
  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log('Failures:');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  return { passed, failed, failures };
}

module.exports = { run };

if (require.main === module) {
  run().then(({ failed }) => {
    process.exitCode = failed > 0 ? 1 : 0;
  }).catch((err) => {
    console.error('UNCAUGHT TEST ERROR:', err);
    process.exitCode = 2;
  });
}
