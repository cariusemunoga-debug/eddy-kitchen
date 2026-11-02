const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

(async () => {
  const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'eddys-kitchen.db');
  if (!fs.existsSync(dbPath)) throw new Error(`DATABASE MISSING: ${dbPath}`);
  const bytes = fs.readFileSync(dbPath);
  if (!bytes.length) throw new Error(`DATABASE EMPTY: ${dbPath}`);
  const SQL = await initSqlJs({ locateFile: file => require.resolve('sql.js/dist/' + file) });
  const db = new SQL.Database(new Uint8Array(bytes));
  const integrity = db.exec('PRAGMA quick_check')?.[0]?.values?.[0]?.[0];
  if (String(integrity || '').toLowerCase() !== 'ok') throw new Error(`SQLite integrity check failed: ${integrity}`);
  const tables = new Set((db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values || []).map(row => String(row[0])));
  const required = ['customers','admins','orders','payments','menu_items','inventory_items','riders','app_settings','sessions'];
  const missing = required.filter(name => !tables.has(name));
  if (missing.length) throw new Error(`Required tables are missing: ${missing.join(', ')}`);
  const count = name => Number(db.exec(`SELECT COUNT(*) FROM "${name}"`)[0]?.values?.[0]?.[0] || 0);
  console.log('EDDY KITCHEN DATABASE HEALTH CHECK');
  console.log(`File: ${dbPath}`);
  console.log(`Size: ${bytes.length.toLocaleString()} bytes`);
  console.log(`Integrity: ${integrity}`);
  console.log(`Tables: ${tables.size}`);
  for (const name of ['customers','admins','orders','payments','menu_items','inventory_items','riders','promotions']) {
    if (tables.has(name)) console.log(`${name}: ${count(name)} records`);
  }
  console.log('Database file is readable and has the required core tables.');
  db.close();
})().catch(error => {
  console.error('DATABASE HEALTH CHECK FAILED:', error.message);
  process.exitCode = 1;
});
