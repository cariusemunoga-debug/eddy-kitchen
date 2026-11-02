const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

(async () => {
  const dbPath = path.resolve(process.env.DATABASE_PATH || path.join(__dirname, 'eddys-kitchen.db'));
  const bundledBackup = path.join(__dirname, 'eddys-kitchen.db.before-backend-repair-1793515862.bak');
  const candidates = [dbPath, bundledBackup, path.join(__dirname, '..', 'eddys-kitchen.db')];
  const SQL = await initSqlJs({ locateFile: file => require.resolve('sql.js/dist/' + file) });
  const inspect = file => {
    const bytes = fs.readFileSync(file);
    if (!bytes.length) throw new Error('file is empty');
    const db = new SQL.Database(new Uint8Array(bytes));
    const result = db.exec('PRAGMA quick_check');
    const status = result?.[0]?.values?.[0]?.[0];
    if (String(status).toLowerCase() !== 'ok') { db.close(); throw new Error('SQLite integrity check failed: ' + status); }
    const tables = new Set((db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values || []).map(r => String(r[0])));
    const missing = ['customers','admins','orders','payments','menu_items','inventory_items','riders','app_settings','sessions'].filter(t => !tables.has(t));
    if (missing.length) { db.close(); throw new Error('missing required tables: ' + missing.join(', ')); }
    const count = t => Number(db.exec(`SELECT COUNT(*) FROM "${t}"`)[0].values[0][0]);
    const summary = { customers: count('customers'), admins: count('admins'), orders: count('orders'), menu_items: count('menu_items') };
    db.close();
    return { bytes, summary };
  };

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (fs.existsSync(dbPath)) {
    try {
      const valid = inspect(dbPath);
      console.log('Database is present and readable:', dbPath);
      console.log('Database records:', JSON.stringify(valid.summary));
      return;
    } catch (err) {
      console.error('Existing database cannot be opened:', err.message);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const preserved = dbPath + '.unreadable-' + stamp + '.bak';
      try { fs.copyFileSync(dbPath, preserved); console.log('Preserved the unreadable original at:', preserved); } catch (copyErr) { console.error('Could not preserve original:', copyErr.message); }
    }
  }

  for (const candidate of candidates.slice(1)) {
    if (!fs.existsSync(candidate) || path.resolve(candidate) === dbPath) continue;
    try {
      const valid = inspect(candidate);
      const temp = dbPath + '.restore-temp';
      fs.writeFileSync(temp, valid.bytes);
      fs.renameSync(temp, dbPath);
      console.log('Restored a verified database copy from:', candidate);
      console.log('Database records:', JSON.stringify(valid.summary));
      return;
    } catch (err) {
      console.warn('Skipped database backup', candidate, '-', err.message);
    }
  }
  throw new Error('No verified database copy was found. No new empty database was created.');
})().catch(err => { console.error('DATABASE REPAIR FAILED:', err.message); process.exit(1); });
