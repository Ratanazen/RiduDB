const {
  validate,
  connect,
  disconnect,
  listConnections,
  listTables,
  listColumns,
  executeQuery,
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

function section(title) {
  console.log(`\n== ${title} ==`);
}

const MYSQL_PROFILE = {
  name: 'MySQL Test',
  engine: 'mysql',
  host: 'localhost',
  port: 3307,
  database: 'ridudb_test_mysql',
  username: 'root',
  password: '',
};

async function run() {
  // ---- 1. Profile validation ----
  section('Profile validation');
  const v1 = await validate(MYSQL_PROFILE);
  assert(v1.valid === true, 'valid mysql profile passes');
  assert(JSON.stringify(v1.errors) === '[]', 'no errors for valid profile');

  const v2 = await validate({ name: '', engine: 'mysql', host: '', database: '', port: 99999 });
  assert(v2.valid === false, 'invalid mysql profile rejected');
  assert(v2.errors.length > 0, 'errors reported');

  // ---- 2. Connect ----
  section('Connect to MySQL');
  const conn = await connect(MYSQL_PROFILE);
  assert(conn.engine === 'mysql', 'connection engine is mysql');
  assert(typeof conn.connectionId === 'string' && conn.connectionId.length > 0, 'connectionId returned');
  assert(conn.database === 'ridudb_test_mysql', 'database returned');

  const list = listConnections();
  assert(list.connections.length >= 1, 'connection registered');

  // ---- 3. Inspect tables ----
  section('Inspect tables');
  const tables = await listTables(conn.connectionId);
  const tableNames = tables.tables.map((t) => t.name).sort();
  assert(tableNames.includes('employees'), 'employees table listed');
  assert(tableNames.includes('departments'), 'departments table listed');
  assert(tableNames.includes('empty_table'), 'empty_table listed');
  const emp = tables.tables.find((t) => t.name === 'employees');
  assert(emp.type === 'table', 'employees type is table');

  // ---- 4. Inspect columns ----
  section('Inspect columns');
  const cols = await listColumns(conn.connectionId, 'employees');
  const colNames = cols.columns.map((c) => c.name);
  assert(colNames.includes('id'), 'id column present');
  assert(colNames.includes('name'), 'name column present');
  assert(colNames.includes('email'), 'email column present');
  const emailCol = cols.columns.find((c) => c.name === 'email');
  assert(emailCol.isNullable === true, 'email column is nullable');
  const nameCol = cols.columns.find((c) => c.name === 'name');
  assert(nameCol.isNullable === false, 'name column is not nullable');

  try {
    await listColumns(conn.connectionId, 'does_not_exist');
    assert(false, 'nonexistent table should throw');
  } catch (err) {
    assert(err.code !== undefined, 'nonexistent table throws typed error');
  }

  // ---- 5. Execute read-only query ----
  section('Execute read-only query');
  const q1 = await executeQuery(conn.connectionId, {
    sql: 'SELECT id, name, department FROM employees ORDER BY id',
  });
  assert(q1.status === 'ok', 'query status ok');
  assert(q1.rowCount === 3, '3 rows returned');
  assert(q1.columns.length === 3, '3 columns returned');
  assert(q1.columns[0].name === 'id', 'first column id');
  assert(q1.rows[0][0] === 1 && q1.rows[0][1] === 'Alice', 'first row values');
  assert(!q1.truncated, 'not truncated');

  // ---- 6. NULL values ----
  section('NULL values');
  const q2 = await executeQuery(conn.connectionId, {
    sql: 'SELECT id, name, email, salary FROM employees WHERE id = 2',
  });
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
    assert(err.driver === 'mysql', 'driver is mysql');
  }
  try {
    await executeQuery(conn.connectionId, { sql: 'DELETE FROM employees' });
    assert(false, 'DELETE should be rejected');
  } catch (err) {
    assert(err.code === 'INVALID_SQL', 'DELETE rejected as INVALID_SQL');
  }
  try {
    await executeQuery(conn.connectionId, { sql: '' });
    assert(false, 'empty sql should be rejected');
  } catch (err) {
    assert(err.code === 'INVALID_SQL', 'empty sql rejected');
  }

  // ---- 9. Parameterized query ----
  section('Parameterized query');
  const q4 = await executeQuery(conn.connectionId, {
    sql: 'SELECT name FROM employees WHERE department = ? ORDER BY name',
    params: ['Engineering'],
  });
  assert(q4.status === 'ok', 'parameterized query ok');
  assert(q4.rowCount === 2, '2 engineering employees');
  const names = q4.rows.map((r) => r[0]).sort();
  assert(names[0] === 'Alice' && names[1] === 'Bob', 'engineering names correct');

  // ---- 10. Disconnect ----
  section('Disconnect');
  await disconnect(conn.connectionId);
  const listAfter = listConnections();
  const remaining = listAfter.connections.filter((c) => c.connectionId === conn.connectionId);
  assert(remaining.length === 0, 'connection removed after disconnect');

  try {
    await executeQuery(conn.connectionId, { sql: 'SELECT 1' });
    assert(false, 'query on closed connection should throw');
  } catch (err) {
    assert(err.code === 'CONNECTION_CLOSED', 'closed connection throws CONNECTION_CLOSED');
  }

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
