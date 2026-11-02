const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

async function boot() {
const app = express();
const BUILD_ID = '2026-11-01-single-backend-database-lock-9';
if (process.env.NODE_ENV === 'production') {
  // A missing admin configuration must not take the entire customer-facing site offline.
  // Keep a strong session secret mandatory; admin login reports its own configuration error below.
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must be set to at least 32 characters in production.');
}
// PORT=0 deliberately asks Windows/Linux to allocate an available ephemeral port.
const PORT = process.env.PORT !== undefined && process.env.PORT !== '' ? Number(process.env.PORT) : 3000;
const dbPath = path.resolve(process.env.DATABASE_PATH || path.join(__dirname, 'eddys-kitchen.db'));
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
// A single sql.js process must own a database file at a time. The previous
// launcher could start two backend processes, which risked overwriting each
// other's exported SQLite images. This lock prevents that from happening.
const dbLockPath = dbPath + '.server.lock';
function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error && error.code === 'EPERM'; }
}
function acquireDatabaseLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(dbLockPath, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      fs.closeSync(fd);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(dbLockPath, 'utf8')); } catch (_) {}
      if (owner && processIsAlive(Number(owner.pid))) {
        throw new Error(`This database is already being used by Eddys Kitchen process ${owner.pid}. Close the other Eddys Kitchen server window before starting another copy.`);
      }
      // Remove only a stale/malformed lock; never touch the database itself.
      try { fs.unlinkSync(dbLockPath); } catch (unlinkError) {
        throw new Error(`Could not clear stale database lock ${dbLockPath}: ${unlinkError.message}`);
      }
    }
  }
  throw new Error('Could not acquire the Eddys Kitchen database lock.');
}
function releaseDatabaseLock() {
  try {
    const owner = JSON.parse(fs.readFileSync(dbLockPath, 'utf8'));
    if (Number(owner.pid) === process.pid) fs.unlinkSync(dbLockPath);
  } catch (_) {}
}
acquireDatabaseLock();
process.on('exit', releaseDatabaseLock);
process.on('SIGINT', () => { releaseDatabaseLock(); process.exit(130); });
process.on('SIGTERM', () => { releaseDatabaseLock(); process.exit(0); });
// Recover a common older layout safely: some earlier packages stored the DB
// beside package.json. Only copy it when the configured database is absent.
if (!process.env.DATABASE_PATH && !fs.existsSync(dbPath)) {
  const legacyDbPath = path.join(__dirname, '..', 'eddys-kitchen.db');
  if (fs.existsSync(legacyDbPath) && fs.statSync(legacyDbPath).size > 0) {
    fs.copyFileSync(legacyDbPath, dbPath);
    console.log(`Recovered existing database from legacy location: ${legacyDbPath}`);
  }
}
// On hosts such as Render, uploaded images must live on the persistent disk, not the deploy folder.
const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'frontend', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
const SQL = await initSqlJs({ locateFile: file => require.resolve('sql.js/dist/' + file) });
let rawDb;
function inspectDatabaseBytes(bytes) {
  const candidate = new SQL.Database(new Uint8Array(bytes));
  const integrity = candidate.exec('PRAGMA quick_check');
  const integrityResult = integrity?.[0]?.values?.[0]?.[0];
  if (String(integrityResult || '').toLowerCase() !== 'ok') throw new Error('SQLite quick_check did not return ok.');
  const tables = new Set((candidate.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values || []).map(row => String(row[0])));
  const count = table => tables.has(table) ? Number(candidate.exec(`SELECT COUNT(*) FROM "${table}"`)[0]?.values?.[0]?.[0] || 0) : 0;
  return { candidate, tables, customers: count('customers'), orders: count('orders'), admins: count('admins') };
}
// If this package contains a fresh starter DB but the user also has an older
// populated DB beside the project folder, preserve the starter DB and recover
// the populated one. Never replace a DB that already contains user accounts/orders.
if (!process.env.DATABASE_PATH && fs.existsSync(dbPath)) {
  try {
    const current = inspectDatabaseBytes(fs.readFileSync(dbPath));
    const currentHasAccountsOrOrders = current.customers > 0 || current.orders > 0 || current.admins > 0;
    if (!currentHasAccountsOrOrders) {
      const legacyCandidates = [path.join(__dirname, '..', 'eddys-kitchen.db'), path.join(process.cwd(), 'eddys-kitchen.db')]
        .filter((candidate, index, list) => candidate !== dbPath && fs.existsSync(candidate) && fs.statSync(candidate).size > 0 && list.indexOf(candidate) === index);
      for (const legacyPath of legacyCandidates) {
        try {
          const legacy = inspectDatabaseBytes(fs.readFileSync(legacyPath));
          if (legacy.customers + legacy.orders + legacy.admins > 0) {
            const starterBackup = `${dbPath}.starter-${Date.now()}.bak`;
            fs.copyFileSync(dbPath, starterBackup);
            fs.copyFileSync(legacyPath, dbPath);
            console.log(`Recovered populated database from ${legacyPath}; starter database preserved at ${starterBackup}`);
            break;
          }
        } catch (legacyError) {
          console.warn(`Skipped legacy database candidate ${legacyPath}: ${legacyError.message}`);
        }
      }
    }
  } catch (recoveryError) {
    console.warn('Automatic legacy database recovery was skipped:', recoveryError.message);
  }
}
if (fs.existsSync(dbPath)) {
  try {
    const existingBytes = fs.readFileSync(dbPath);
    if (!existingBytes.length) throw new Error('The database file is empty.');
    const inspected = inspectDatabaseBytes(existingBytes);
    rawDb = inspected.candidate;
  } catch (error) {
    throw new Error(`DATABASE COULD NOT BE OPENED: ${error.message}. Your existing database was NOT replaced. Close the app and make a copy of: ${dbPath}`);
  }
} else {
  console.log(`No existing database was found at ${dbPath}. A new database will be initialized there.`);
  rawDb = new SQL.Database();
}
// Preserve the pre-migration database once before schema changes are applied.
if (fs.existsSync(dbPath)) {
  const backupPath = dbPath + '.pre-migration.bak';
  if (!fs.existsSync(backupPath)) fs.copyFileSync(dbPath, backupPath);
}
let inTransaction = false;
function persist() {
  if (inTransaction) return;
  const temporaryPath = dbPath + '.writing-' + process.pid;
  const replacementBackup = dbPath + '.replace-backup';
  let fd;
  try {
    // Flush a complete SQLite image to disk before replacing the live file.
    const bytes = Buffer.from(rawDb.export());
    fd = fs.openSync(temporaryPath, 'w');
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    if (process.platform === 'win32' && fs.existsSync(dbPath)) {
      // Windows does not reliably replace an existing destination with renameSync.
      // Move the old file aside, install the complete new file, then remove the backup.
      try { fs.rmSync(replacementBackup, { force: true }); } catch (_) {}
      fs.renameSync(dbPath, replacementBackup);
      try {
        fs.renameSync(temporaryPath, dbPath);
        fs.rmSync(replacementBackup, { force: true });
      } catch (replaceError) {
        if (!fs.existsSync(dbPath) && fs.existsSync(replacementBackup)) {
          fs.renameSync(replacementBackup, dbPath);
        }
        throw replaceError;
      }
    } else {
      fs.renameSync(temporaryPath, dbPath);
    }
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
    try { fs.rmSync(temporaryPath, { force: true }); } catch (_) {}
    console.error('DATABASE SAVE ERROR:', e.message);
    throw new Error(`Database changes could not be saved to disk: ${e.message}`);
  }
}
function bindArgs(sql, args) {
  if (args.length === 1 && args[0] && !Array.isArray(args[0]) && typeof args[0] === 'object') {
    const obj = args[0], names = [...sql.matchAll(/[@:$][A-Za-z_][A-Za-z0-9_]*/g)].map(m => m[0]);
    const result = {}; for (const name of names) { const bare = name.slice(1); if (Object.prototype.hasOwnProperty.call(obj, name)) result[name] = obj[name]; else if (Object.prototype.hasOwnProperty.call(obj, bare)) result[name] = obj[bare]; }
    return result;
  }
  return args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
}
const db = {
  exec(sql) { rawDb.exec(sql); persist(); },
  prepare(sql) {
    return {
      get(...args) { const st=rawDb.prepare(sql); try { const b=bindArgs(sql,args); if ((Array.isArray(b)&&b.length)||(!Array.isArray(b)&&Object.keys(b).length)) st.bind(b); return st.step()?st.getAsObject():undefined; } finally { st.free(); } },
      all(...args) { const st=rawDb.prepare(sql); const rows=[]; try { const b=bindArgs(sql,args); if ((Array.isArray(b)&&b.length)||(!Array.isArray(b)&&Object.keys(b).length)) st.bind(b); while(st.step()) rows.push(st.getAsObject()); return rows; } finally { st.free(); } },
      run(...args) { const b=bindArgs(sql,args); rawDb.run(sql,b); const changes=rawDb.getRowsModified(); const row=rawDb.exec('SELECT last_insert_rowid() AS id'); const lastInsertRowid=row.length?row[0].values[0][0]:0; persist(); return {changes,lastInsertRowid}; }
    };
  },
  transaction(fn) { return (...args) => { rawDb.run('BEGIN'); inTransaction=true; try { const r=fn(...args); rawDb.run('COMMIT'); inTransaction=false; persist(); return r; } catch(e) { rawDb.run('ROLLBACK'); inTransaction=false; persist(); throw e; } }; }
};
db.exec(`
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  items_json TEXT NOT NULL,
  total INTEGER NOT NULL,
  delivery_address TEXT NOT NULL,
  notes TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Received',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  customer_lat REAL, customer_lng REAL, rider_lat REAL, rider_lng REAL, rider_updated_at TEXT,
  FOREIGN KEY(customer_id) REFERENCES customers(id)
);
CREATE TABLE IF NOT EXISTS promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  discount_percent INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, image_url TEXT NOT NULL DEFAULT '', slide_duration_seconds INTEGER NOT NULL DEFAULT 5, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, cuisine TEXT NOT NULL DEFAULT 'International',
  price INTEGER NOT NULL, description TEXT NOT NULL DEFAULT '', emoji TEXT NOT NULL DEFAULT '🍽️', image_url TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS riders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT NOT NULL, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expired INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
 id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, customer_id INTEGER NOT NULL,
 method TEXT NOT NULL DEFAULT 'Cash on delivery', amount INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'Pending', provider_reference TEXT NOT NULL DEFAULT '', tx_ref TEXT NOT NULL DEFAULT '', provider_transaction_id TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS notifications (
 id INTEGER PRIMARY KEY AUTOINCREMENT, audience TEXT NOT NULL, audience_id INTEGER,
 title TEXT NOT NULL, message TEXT NOT NULL, order_id INTEGER, is_read INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS customer_addresses (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, label TEXT NOT NULL DEFAULT 'Home', address TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(customer_id) REFERENCES customers(id));
CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS inventory_items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, unit TEXT NOT NULL DEFAULT 'units', quantity REAL NOT NULL DEFAULT 0, low_stock REAL NOT NULL DEFAULT 0, unit_cost INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'General', amount INTEGER NOT NULL, expense_date TEXT NOT NULL DEFAULT (date('now')), notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS staff_records (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS branches (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, address TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS suppliers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS stock_purchases (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER, item_id INTEGER NOT NULL, quantity REAL NOT NULL, unit_cost INTEGER NOT NULL, total_cost INTEGER NOT NULL, purchased_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, notes TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS refunds (id INTEGER PRIMARY KEY AUTOINCREMENT, payment_id INTEGER NOT NULL, order_id INTEGER NOT NULL, amount INTEGER NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Requested', provider_reference TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS staff_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, staff_record_id INTEGER, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL, permissions_json TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS staff_attendance (id INTEGER PRIMARY KEY AUTOINCREMENT, staff_record_id INTEGER NOT NULL, attendance_date TEXT NOT NULL DEFAULT (date('now')), check_in TEXT, check_out TEXT, notes TEXT NOT NULL DEFAULT '', UNIQUE(staff_record_id,attendance_date));
CREATE TABLE IF NOT EXISTS stock_recipes (id INTEGER PRIMARY KEY AUTOINCREMENT, menu_item_id INTEGER NOT NULL, inventory_item_id INTEGER NOT NULL, quantity REAL NOT NULL, UNIQUE(menu_item_id,inventory_item_id));
CREATE TABLE IF NOT EXISTS stock_wastage (id INTEGER PRIMARY KEY AUTOINCREMENT, inventory_item_id INTEGER NOT NULL, quantity REAL NOT NULL, reason TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS customer_complaints (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, order_id INTEGER, subject TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Open', admin_note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS order_events (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, actor TEXT NOT NULL, event TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS order_stock_deductions (order_id INTEGER PRIMARY KEY, deducted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
`);
// Idempotent schema migrations: check the real table definition before
// altering it. This avoids hiding genuine migration failures behind broad catches.
function ensureColumn(table, definition) {
  const column = definition.trim().split(/\s+/, 1)[0];
  const existing = rawDb.exec(`PRAGMA table_info("${table}")`)[0]?.values || [];
  if (!existing.some(row => String(row[1]).toLowerCase() === column.toLowerCase())) {
    db.exec(`ALTER TABLE "${table}" ADD COLUMN ${definition}`);
  }
}
ensureColumn('promotions', "image_url TEXT NOT NULL DEFAULT ''");
ensureColumn('promotions', 'slide_duration_seconds INTEGER NOT NULL DEFAULT 5');
ensureColumn('customers', 'loyalty_points INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders', 'loyalty_awarded INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders', 'branch_id INTEGER');
for (const definition of [
  "payment_method TEXT NOT NULL DEFAULT 'Cash on delivery'", "payment_status TEXT NOT NULL DEFAULT 'Pending'",
  'delivery_fee INTEGER NOT NULL DEFAULT 0', 'customer_lat REAL', 'customer_lng REAL', 'rider_lat REAL',
  'rider_lng REAL', 'rider_updated_at TEXT', "image_url TEXT NOT NULL DEFAULT ''", 'rider_id INTEGER'
]) ensureColumn('orders', definition);
ensureColumn('payments', "tx_ref TEXT NOT NULL DEFAULT ''");
ensureColumn('payments', "provider_transaction_id TEXT NOT NULL DEFAULT ''");
for (const definition of [
  "online INTEGER NOT NULL DEFAULT 0", "last_seen TEXT", "vehicle_type TEXT NOT NULL DEFAULT ''",
  "vehicle_registration TEXT NOT NULL DEFAULT ''", "emergency_contact TEXT NOT NULL DEFAULT ''"
]) ensureColumn('riders', definition);
ensureColumn('orders', "rider_assignment_status TEXT NOT NULL DEFAULT 'Assigned'");
ensureColumn('orders', 'discount_amount INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders', "discount_code TEXT NOT NULL DEFAULT ''");
ensureColumn('orders', 'tax_amount INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders', 'scheduled_for TEXT');


db.exec(`
CREATE TABLE IF NOT EXISTS delivery_zones (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,fee INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS discount_codes (id INTEGER PRIMARY KEY AUTOINCREMENT,code TEXT NOT NULL UNIQUE,discount_percent INTEGER NOT NULL,starts_at TEXT,ends_at TEXT,max_uses INTEGER NOT NULL DEFAULT 0,uses INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS stock_batches (id INTEGER PRIMARY KEY AUTOINCREMENT,item_id INTEGER NOT NULL,quantity REAL NOT NULL,expiry_date TEXT,notes TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS stocktakes (id INTEGER PRIMARY KEY AUTOINCREMENT,item_id INTEGER NOT NULL,system_quantity REAL NOT NULL,counted_quantity REAL NOT NULL,difference REAL NOT NULL,notes TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS staff_payroll (id INTEGER PRIMARY KEY AUTOINCREMENT,staff_record_id INTEGER NOT NULL,pay_period TEXT NOT NULL,amount INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'Unpaid',paid_at TEXT,notes TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS staff_leave (id INTEGER PRIMARY KEY AUTOINCREMENT,staff_record_id INTEGER NOT NULL,start_date TEXT NOT NULL,end_date TEXT NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'Pending',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS support_tickets (id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER,subject TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'Open',admin_reply TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS referral_codes (id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER NOT NULL,code TEXT NOT NULL UNIQUE,uses INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS security_events (id INTEGER PRIMARY KEY AUTOINCREMENT,event TEXT NOT NULL,username TEXT NOT NULL DEFAULT '',ip TEXT NOT NULL DEFAULT '',details TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_stock_batches_expiry ON stock_batches(expiry_date);
CREATE INDEX IF NOT EXISTS idx_payroll_period ON staff_payroll(pay_period);
CREATE INDEX IF NOT EXISTS idx_support_status ON support_tickets(status);
`);

class SQLiteSessionStore extends session.Store {
  constructor(database) {
    super();
    this.getSession = database.prepare('SELECT sess, expired FROM sessions WHERE sid = ?');
    this.saveSession = database.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expired) VALUES (?, ?, ?)');
    this.deleteSession = database.prepare('DELETE FROM sessions WHERE sid = ?');
    this.deleteExpiredSessions = database.prepare('DELETE FROM sessions WHERE expired <= ?');
  }

  get(sid, callback) {
    try {
      const row = this.getSession.get(sid);
      if (!row) return callback(null, null);
      if (row.expired <= Date.now()) {
        this.deleteSession.run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.sess));
    } catch (error) {
      callback(error);
    }
  }

  set(sid, sess, callback) {
    try {
      const expires = sess.cookie && sess.cookie.expires
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + 1000 * 60 * 60 * 24;
      this.saveSession.run(sid, JSON.stringify(sess), expires);
      if (callback) callback(null);
    } catch (error) {
      if (callback) callback(error);
      else throw error;
    }
  }

  destroy(sid, callback) {
    try {
      this.deleteSession.run(sid);
      if (callback) callback(null);
    } catch (error) {
      if (callback) callback(error);
      else throw error;
    }
  }

  touch(sid, sess, callback) {
    this.set(sid, sess, callback);
  }
}

const sessionStore = new SQLiteSessionStore(db);
const sessionCleanup = setInterval(() => sessionStore.deleteExpiredSessions.run(Date.now()), 15 * 60 * 1000);
sessionCleanup.unref();

app.use(express.json({ limit: '40mb' }));
// Keep order and GPS responses fresh; tracking must never be served from a stale browser cache.
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate'); res.set('Pragma', 'no-cache'); res.set('Expires', '0'); next(); });

// Flutterwave hosted checkout. Secret keys remain on the server and are never sent to browsers.
const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY || '';
const FLW_WEBHOOK_SECRET_HASH = process.env.FLW_WEBHOOK_SECRET_HASH || '';
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
async function verifyFlutterwaveTransaction(transactionId, expectedRef, expectedAmount) {
  if (!FLW_SECRET_KEY || !transactionId) return false;
  const response = await fetch(`https://api.flutterwave.com/v3/transactions/${encodeURIComponent(transactionId)}/verify`, {
    headers: { Authorization: `Bearer ${FLW_SECRET_KEY}`, Accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`Flutterwave verification returned HTTP ${response.status}`);
  const body = await response.json();
  const tx = body && body.data;
  return !!(body.status === 'success' && tx && tx.status === 'successful' &&
    String(tx.tx_ref) === String(expectedRef) && String(tx.currency) === 'UGX' &&
    Number(tx.amount) >= Number(expectedAmount));
}
function markFlutterwavePaymentPaid(txRef, transactionId) {
  const payment = db.prepare('SELECT * FROM payments WHERE tx_ref=?').get(String(txRef));
  if (!payment) return false;
  if (payment.status === 'Paid') return true;
  db.transaction(() => {
    db.prepare("UPDATE payments SET status='Paid',provider_reference=?,provider_transaction_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(String(txRef), String(transactionId), payment.id);
    db.prepare("UPDATE orders SET payment_status='Paid' WHERE id=?").run(payment.order_id);
    db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)')
      .run('flutterwave','payment_verified',`Flutterwave verified payment for order #${payment.order_id}`);
    notify('customer',payment.customer_id,'Payment confirmed',`Payment for order #${payment.order_id} has been confirmed.`,payment.order_id);
    notify('admin',null,'Payment received',`Flutterwave confirmed UGX ${payment.amount} for order #${payment.order_id}.`,payment.order_id);
  });
  return true;
}
app.post('/api/payments/flutterwave/webhook', async (req, res) => {
  if (!FLW_WEBHOOK_SECRET_HASH || req.get('verif-hash') !== FLW_WEBHOOK_SECRET_HASH) return res.sendStatus(401);
  // Acknowledge promptly; verification is performed before any order is marked paid.
  res.sendStatus(200);
  try {
    const data = req.body && req.body.data;
    if (!data || !data.id || !data.tx_ref) return;
    const payment = db.prepare('SELECT * FROM payments WHERE tx_ref=?').get(String(data.tx_ref));
    if (!payment || payment.status === 'Paid') return;
    if (await verifyFlutterwaveTransaction(data.id, payment.tx_ref, payment.amount)) markFlutterwavePaymentPaid(payment.tx_ref, data.id);
  } catch (error) { console.error('Flutterwave webhook verification failed:', error.message); }
});
app.get('/payment-callback', async (req, res) => {
  const txRef = String(req.query.tx_ref || '');
  const transactionId = String(req.query.transaction_id || '');
  try {
    const payment = db.prepare('SELECT * FROM payments WHERE tx_ref=?').get(txRef);
    if (payment && transactionId && await verifyFlutterwaveTransaction(transactionId, txRef, payment.amount)) {
      markFlutterwavePaymentPaid(txRef, transactionId);
      return res.redirect('/?payment=successful');
    }
    return res.redirect('/?payment=pending');
  } catch (error) {
    console.error('Flutterwave callback verification failed:', error.message);
    return res.redirect('/?payment=pending');
  }
});

if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'change-this-secret-before-deployment',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 24 * 7 }
}));
// Serve uploaded food photos from the persistent upload directory on production hosts.
app.use('/uploads', express.static(uploadsDir, { maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0, immutable: process.env.NODE_ENV === 'production' }));
app.use(express.static(path.join(__dirname, '..', 'frontend'), { index: 'index.html' }));
// Friendly rider portal URL; the .html URL remains supported too.
app.get('/rider', (req, res) => res.sendFile(path.join(__dirname, '..', 'frontend', 'rider.html')));
app.get('/api/health', (req, res) => {
  try {
    const check = rawDb.exec('PRAGMA quick_check');
    const integrity = check?.[0]?.values?.[0]?.[0];
    const dbOk = String(integrity || '').toLowerCase() === 'ok';
    res.status(dbOk ? 200 : 503).json({ ok: dbOk, database: dbOk ? 'ok' : 'error', app: 'eddys-kitchen', build: BUILD_ID, time: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({ ok: false, database: 'error', app: 'eddys-kitchen', build: BUILD_ID });
  }
});

function currentCustomer(req, res, next) {
  if (!req.session.customerId) return res.status(401).json({ error: 'Please sign in first.' });
  const customer = db.prepare('SELECT id, name, email, phone FROM customers WHERE id = ?').get(req.session.customerId);
  if (!customer) { req.session.destroy(() => {}); return res.status(401).json({ error: 'Please sign in again.' }); }
  req.customer = customer; next();
}

function establishCustomerSession(req, customerId, res, customer) {
  // Rotate the session ID on authentication to prevent session fixation.
  req.session.regenerate(err => {
    if (err) {
      console.error('Could not regenerate customer session:', err.message);
      return res.status(500).json({ error: 'Your account was saved, but sign-in could not be started. Please sign in again.' });
    }
    req.session.customerId = Number(customerId);
    req.session.isAdmin = false;
    req.session.riderId = null;
    req.session.save(saveErr => {
      if (saveErr) {
        console.error('Could not save customer session:', saveErr.message);
        return res.status(500).json({ error: 'Could not save your sign-in. Please try again.' });
      }
      res.json({ customer: { id: customer.id, name: customer.name, email: customer.email, phone: customer.phone } });
    });
  });
}

app.post('/api/register', async (req, res) => {
  const registrationSetting = db.prepare("SELECT value FROM app_settings WHERE key='public_registration_enabled'").get();
  if (registrationSetting && registrationSetting.value === 'false') return res.status(403).json({ error: 'New customer registration is currently closed. Please contact Eddys Kitchen.' });
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const phone = String(req.body.phone || '').trim();
  const password = String(req.body.password || '');
  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || phone.length < 7 || password.length < 8) {
    return res.status(400).json({ error: 'Enter a name, valid email, phone number, and password of at least 8 characters.' });
  }
  try {
    const hash = await bcrypt.hash(password, 12);
    const result = db.prepare('INSERT INTO customers (name,email,phone,password_hash) VALUES (?,?,?,?)').run(name,email,phone,hash);
    establishCustomerSession(req, Number(result.lastInsertRowid), res, { id: Number(result.lastInsertRowid), name, email, phone });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'An account with that email already exists. Please sign in.' });
    console.error(e); res.status(500).json({ error: 'Could not create account. Please try again.' });
  }
});

app.post('/api/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const customer = db.prepare('SELECT * FROM customers WHERE email = ?').get(email);
  if (!customer || !(await bcrypt.compare(password, customer.password_hash))) return res.status(401).json({ error: 'Email or password is incorrect.' });
  establishCustomerSession(req, customer.id, res, customer);
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(err => {
    res.clearCookie('connect.sid', { path: '/' });
    if (err) return res.status(500).json({ error: 'Could not sign out cleanly. Please close this browser tab.' });
    res.json({ ok: true });
  });
});

function adminOnly(req,res,next){ if(!req.session.isAdmin) return res.status(401).json({error:'Admin sign-in required.'}); next(); }
app.get('/api/admin/session',(req,res)=>res.json({authenticated:!!req.session.isAdmin}));
app.get('/api/admin/setup-status',(req,res)=>res.json({canCreate:!db.prepare('SELECT id FROM admins LIMIT 1').get()}));
app.post('/api/admin/register',async(req,res)=>{
  // One-time first-admin setup is available on fresh installs, including production.
  // Once the first admin exists, registration is permanently closed unless the database is reset by the owner.
  if(db.prepare('SELECT id FROM admins LIMIT 1').get()) return res.status(409).json({error:'The private admin account has already been created. Please sign in.'});
  const username=String(req.body.username||'').trim().toLowerCase();
  const password=String(req.body.password||'');
  const confirm=String(req.body.confirmPassword||'');
  if(!/^[a-z0-9._-]{3,40}$/.test(username)) return res.status(400).json({error:'Username must be 3–40 characters and use letters, numbers, dots, underscores or hyphens.'});
  if(password.length<10) return res.status(400).json({error:'Choose a password with at least 10 characters.'});
  if(password!==confirm) return res.status(400).json({error:'The passwords do not match.'});
  try {
    const hash=await bcrypt.hash(password,12);
    // Recheck and insert inside a transaction so concurrent requests cannot create multiple first admins.
    try {
      db.transaction(() => {
        if (db.prepare('SELECT id FROM admins LIMIT 1').get()) throw new Error('ADMIN_ALREADY_EXISTS');
        db.prepare('INSERT INTO admins(username,password_hash) VALUES(?,?)').run(username,hash);
      })();
    } catch (createError) {
      if (createError.message === 'ADMIN_ALREADY_EXISTS') return res.status(409).json({error:'The private admin account has already been created. Please sign in.'});
      throw createError;
    }
    req.session.regenerate(err=>{
      if(err) return res.status(500).json({error:'Admin account was created, but sign-in could not start. Please sign in.'});
      req.session.isAdmin=true; req.session.riderId=null; req.session.customerId=null;
      req.session.save(saveErr=>{if(saveErr)return res.status(500).json({error:'Account created, but the session could not be saved. Please sign in.'});res.json({ok:true});});
    });
  } catch(e) { if(String(e.message).includes('UNIQUE'))return res.status(409).json({error:'That admin username is already in use.'}); console.error(e);res.status(500).json({error:'Could not create the admin account. Please try again.'}); }
});
app.post('/api/admin/login',async(req,res)=>{
  try { db.prepare('INSERT INTO security_events(event,username,ip,details) VALUES(?,?,?,?)').run('admin_login_attempt',String(req.body.username||'').slice(0,80),String(req.ip||'').slice(0,80),'Admin login attempt'); } catch (_) {}

  const username=String(req.body.username||'').trim().toLowerCase();
  const password=String(req.body.password||'');
  const savedAdmin=db.prepare('SELECT id,username,password_hash FROM admins WHERE username=?').get(username);
  const anyAdmin=db.prepare('SELECT id FROM admins LIMIT 1').get();
  if(!anyAdmin) return res.status(409).json({error:'No admin account exists yet. Select Create account to set up the first private admin account.'});
  const valid=!!savedAdmin && await bcrypt.compare(password,savedAdmin.password_hash);
  if(!valid){try{db.prepare('INSERT INTO security_events(event,username,ip,details) VALUES(?,?,?,?)').run('admin_login_failed',username,String(req.ip||'').slice(0,80),'Invalid admin credentials');}catch(_){}return res.status(401).json({error:'Admin username or password is incorrect. Check the details and try again.'});}
  req.session.regenerate(err=>{if(err){console.error('Could not regenerate admin session:',err.message);return res.status(500).json({error:'Could not start a secure admin session. Please try again.'});}req.session.isAdmin=true;req.session.riderId=null;req.session.customerId=null;req.session.save(saveErr=>{if(saveErr){console.error('Could not save admin session:',saveErr.message);return res.status(500).json({error:'Could not save admin sign-in. Please try again.'});}try{db.prepare('INSERT INTO security_events(event,username,ip,details) VALUES(?,?,?,?)').run('admin_login_success',username,String(req.ip||'').slice(0,80),'Administrator signed in successfully');db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run('admin:'+username,'admin_login','Administrator signed in.');}catch(_){}res.json({ok:true});});});
});
app.post('/api/admin/change-password',adminOnly,async(req,res)=>{const current=String(req.body.currentPassword||''),next=String(req.body.newPassword||'');if(next.length<10)return res.status(400).json({error:'New admin password must contain at least 10 characters.'});const admin=db.prepare('SELECT id,password_hash FROM admins ORDER BY id LIMIT 1').get();if(!admin||!(await bcrypt.compare(current,admin.password_hash)))return res.status(401).json({error:'Current admin password is incorrect.'});db.prepare('UPDATE admins SET password_hash=? WHERE id=?').run(await bcrypt.hash(next,12),admin.id);res.json({ok:true,message:'Admin password changed.'});});
app.post('/api/admin/logout',(req,res)=>{req.session.destroy(err=>{res.clearCookie('connect.sid',{path:'/'});if(err)return res.status(500).json({error:'Could not sign out cleanly.'});res.json({ok:true});});});

function riderOnly(req,res,next){
  if(!req.session.riderId) return res.status(401).json({error:'Rider sign-in required.'});
  const rider=db.prepare('SELECT id,name,phone,username,active FROM riders WHERE id=?').get(req.session.riderId);
  if(!rider || !rider.active){req.session.riderId=null;return res.status(401).json({error:'Rider account is inactive. Contact the administrator.'});}
  req.rider=rider; next();
}

function notify(audience, audienceId, title, message, orderId=null) {
  const settingKey = audience === 'customer' ? 'notify_customers' : audience === 'rider' ? 'notify_riders' : audience === 'admin' ? 'notify_admins' : null;
  if (settingKey) { const pref = db.prepare('SELECT value FROM app_settings WHERE key=?').get(settingKey); if (pref && pref.value === 'false') return; }
  db.prepare('INSERT INTO notifications(audience,audience_id,title,message,order_id) VALUES(?,?,?,?,?)').run(audience, audienceId ?? null, String(title).slice(0,120), String(message).slice(0,500), orderId);
}
function audit(action, details='') { db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run(reqActor(), action, String(details).slice(0,500)); }
function reqActor(){ return 'system'; }
app.get('/api/notifications', currentCustomer, (req,res)=>res.json({notifications:db.prepare("SELECT id,title,message,order_id,is_read,created_at FROM notifications WHERE audience='customer' AND audience_id=? ORDER BY id DESC LIMIT 50").all(req.customer.id)}));
app.patch('/api/notifications/:id/read', currentCustomer, (req,res)=>{db.prepare("UPDATE notifications SET is_read=1 WHERE id=? AND audience='customer' AND audience_id=?").run(Number(req.params.id),req.customer.id);res.json({ok:true});});
function applyRecipeStockDeduction(orderId){
 const already=db.prepare('SELECT order_id FROM order_stock_deductions WHERE order_id=?').get(orderId);if(already)return {deducted:false,already:true};
 const order=db.prepare('SELECT items_json FROM orders WHERE id=?').get(orderId);if(!order)return {deducted:false};
 let items;try{items=JSON.parse(order.items_json)}catch(_){return {deducted:false};}
 const required=new Map();
 for(const line of items){const recipes=db.prepare('SELECT inventory_item_id,quantity FROM stock_recipes WHERE menu_item_id=?').all(Number(line.id));if(!recipes.length){notify('admin',null,'Recipe missing',`Order #${orderId}: no ingredient recipe exists for ${line.name}. Stock was not deducted.`,orderId);return {deducted:false,missing:true};}for(const r of recipes)required.set(r.inventory_item_id,(required.get(r.inventory_item_id)||0)+Number(r.quantity)*Number(line.qty||1));}
 for(const [id,qty] of required){const stock=db.prepare('SELECT * FROM inventory_items WHERE id=?').get(id);if(!stock||Number(stock.quantity)<qty){notify('admin',null,'Insufficient stock',`Order #${orderId}: insufficient ${stock?.name||'ingredient'} stock. Stock was not deducted.`,orderId);return {deducted:false,insufficient:true};}}
 db.transaction(()=>{for(const [id,qty] of required)db.prepare('UPDATE inventory_items SET quantity=quantity-?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(qty,id);db.prepare('INSERT INTO order_stock_deductions(order_id) VALUES(?)').run(orderId);db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run('system','recipe_stock_deduction',`Ingredient stock deducted for delivered order #${orderId}`);})();return {deducted:true};
}
app.get('/api/admin/notifications',adminOnly,(req,res)=>res.json({notifications:db.prepare("SELECT * FROM notifications WHERE audience='admin' ORDER BY id DESC LIMIT 100").all()}));
app.patch('/api/admin/notifications/:id/read',adminOnly,(req,res)=>{const r=db.prepare("UPDATE notifications SET is_read=1 WHERE id=? AND audience='admin'").run(Number(req.params.id));if(!r.changes)return res.status(404).json({error:'Notification not found.'});res.json({ok:true});});
app.patch('/api/admin/notifications/read-all',adminOnly,(req,res)=>{db.prepare("UPDATE notifications SET is_read=1 WHERE audience='admin'").run();res.json({ok:true});});
app.get('/api/admin/payments',adminOnly,(req,res)=>res.json({payments:db.prepare('SELECT p.*,o.status order_status,c.name customer_name,c.phone customer_phone FROM payments p JOIN orders o ON o.id=p.order_id JOIN customers c ON c.id=p.customer_id ORDER BY p.id DESC LIMIT 300').all()}));
app.post('/api/admin/payments/:id/record-reference',adminOnly,(req,res)=>{const ref=String(req.body.reference||'').trim().slice(0,120);if(!ref)return res.status(400).json({error:'Enter the payment provider reference.'});const pmt=db.prepare('SELECT * FROM payments WHERE id=?').get(Number(req.params.id));if(!pmt)return res.status(404).json({error:'Payment not found.'});db.prepare("UPDATE payments SET provider_reference=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(ref,pmt.id);res.json({ok:true,message:'Reference saved for reconciliation. Payment remains unverified until confirmed by the payment provider.'});});
app.post('/api/admin/payments/:id/verify-manual',adminOnly,(req,res)=>{const ref=String(req.body.reference||'').trim().slice(0,120);const confirmed=req.body.confirmReceived===true;if(!ref)return res.status(400).json({error:'Enter the transaction reference before verifying.'});if(!confirmed)return res.status(400).json({error:'Confirm that you checked the transaction in your official merchant account.'});const pmt=db.prepare('SELECT * FROM payments WHERE id=?').get(Number(req.params.id));if(!pmt)return res.status(404).json({error:'Payment not found.'});if(pmt.method==='Cash on delivery')return res.status(400).json({error:'Cash-on-delivery orders are reconciled after delivery, not through this action.'});if(pmt.status==='Paid')return res.status(409).json({error:'This payment is already marked paid.'});db.transaction(()=>{db.prepare("UPDATE payments SET provider_reference=?,status='Paid',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(ref,pmt.id);db.prepare("UPDATE orders SET payment_status='Paid' WHERE id=?").run(pmt.order_id);db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run('admin','manual_payment_verification',`Payment #${pmt.id} / Order #${pmt.order_id} verified manually using reference ${ref}`);const order=db.prepare('SELECT customer_id FROM orders WHERE id=?').get(pmt.order_id);if(order)notify('customer',order.customer_id,'Payment confirmed',`Payment for order #${pmt.order_id} has been confirmed by Eddys Kitchen.`,pmt.order_id);notify('admin',null,'Payment verified',`Payment #${pmt.id} for order #${pmt.order_id} was manually verified.`,pmt.order_id);})();res.json({ok:true,message:'Payment marked paid. Keep the transaction reference for reconciliation.'});});
// Admin business-control APIs: inventory, expenses, staff directory and audit history.
app.get('/api/admin/inventory',adminOnly,(req,res)=>res.json({items:db.prepare('SELECT * FROM inventory_items ORDER BY name').all()}));
app.post('/api/admin/inventory',adminOnly,(req,res)=>{const name=String(req.body.name||'').trim().slice(0,100),unit=String(req.body.unit||'units').trim().slice(0,20),quantity=Number(req.body.quantity),low=Number(req.body.low_stock||0),cost=Number(req.body.unit_cost||0);if(!name||!Number.isFinite(quantity)||quantity<0||!Number.isFinite(low)||low<0||!Number.isInteger(cost)||cost<0)return res.status(400).json({error:'Enter a name and valid non-negative stock and cost values.'});db.prepare('INSERT INTO inventory_items(name,unit,quantity,low_stock,unit_cost) VALUES(?,?,?,?,?)').run(name,unit,quantity,low,cost);db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run('admin','inventory_add',`Added inventory item ${name}`);res.json({ok:true});});
app.patch('/api/admin/inventory/:id',adminOnly,(req,res)=>{const id=Number(req.params.id),item=db.prepare('SELECT * FROM inventory_items WHERE id=?').get(id);if(!item)return res.status(404).json({error:'Inventory item not found.'});const quantity=req.body.quantity===undefined?item.quantity:Number(req.body.quantity),low=req.body.low_stock===undefined?item.low_stock:Number(req.body.low_stock),cost=req.body.unit_cost===undefined?item.unit_cost:Number(req.body.unit_cost);if(!Number.isFinite(quantity)||quantity<0||!Number.isFinite(low)||low<0||!Number.isInteger(cost)||cost<0)return res.status(400).json({error:'Stock and cost values must be valid and non-negative.'});db.prepare('UPDATE inventory_items SET quantity=?,low_stock=?,unit_cost=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(quantity,low,cost,id);db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run('admin','inventory_update',`Updated inventory item ${item.name}`);res.json({ok:true});});
app.delete('/api/admin/inventory/:id',adminOnly,(req,res)=>{const item=db.prepare('SELECT name FROM inventory_items WHERE id=?').get(Number(req.params.id));if(!item)return res.status(404).json({error:'Inventory item not found.'});db.prepare('DELETE FROM inventory_items WHERE id=?').run(Number(req.params.id));db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run('admin','inventory_delete',`Removed inventory item ${item.name}`);res.json({ok:true});});
app.get('/api/admin/expenses',adminOnly,(req,res)=>res.json({expenses:db.prepare('SELECT * FROM expenses ORDER BY expense_date DESC,id DESC LIMIT 500').all(),total:db.prepare('SELECT COALESCE(SUM(amount),0) total FROM expenses').get().total}));
app.post('/api/admin/expenses',adminOnly,(req,res)=>{const title=String(req.body.title||'').trim().slice(0,120),category=String(req.body.category||'General').trim().slice(0,50),amount=Number(req.body.amount),date=String(req.body.expense_date||new Date().toISOString().slice(0,10));if(!title||!Number.isSafeInteger(amount)||amount<1||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date))return res.status(400).json({error:'Enter an expense name, valid amount and date.'});db.prepare('INSERT INTO expenses(title,category,amount,expense_date,notes) VALUES(?,?,?,?,?)').run(title,category,amount,date,String(req.body.notes||'').slice(0,300));db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run('admin','expense_add',`Recorded ${title}: UGX ${amount}`);res.json({ok:true});});
app.delete('/api/admin/expenses/:id',adminOnly,(req,res)=>{const e=db.prepare('SELECT title FROM expenses WHERE id=?').get(Number(req.params.id));if(!e)return res.status(404).json({error:'Expense not found.'});db.prepare('DELETE FROM expenses WHERE id=?').run(Number(req.params.id));db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run('admin','expense_delete',`Removed expense ${e.title}`);res.json({ok:true});});
app.get('/api/admin/staff',adminOnly,(req,res)=>res.json({staff:db.prepare('SELECT * FROM staff_records ORDER BY active DESC,name').all()}));
app.post('/api/admin/staff',adminOnly,(req,res)=>{const name=String(req.body.name||'').trim().slice(0,100),role=String(req.body.role||'').trim().slice(0,50),phone=String(req.body.phone||'').trim().slice(0,30);if(!name||!role)return res.status(400).json({error:'Enter staff name and role.'});db.prepare('INSERT INTO staff_records(name,role,phone) VALUES(?,?,?)').run(name,role,phone);db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run('admin','staff_add',`Added staff record ${name} (${role})`);res.json({ok:true});});
app.patch('/api/admin/staff/:id',adminOnly,(req,res)=>{const id=Number(req.params.id),active=req.body.active?1:0;const r=db.prepare('SELECT name FROM staff_records WHERE id=?').get(id);if(!r)return res.status(404).json({error:'Staff record not found.'});db.prepare('UPDATE staff_records SET active=? WHERE id=?').run(active,id);db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run('admin','staff_status',`${active?'Enabled':'Disabled'} staff record ${r.name}`);res.json({ok:true});});
app.get('/api/admin/activity',adminOnly,(req,res)=>res.json({logs:db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 300').all()}));
// Administrator-wide control centre: read-only overview across every major app area.
app.get('/api/admin/control-centre',adminOnly,(req,res)=>{
 const count=(sql)=>Number(db.prepare(sql).get().count||0);
 const paid=db.prepare("SELECT COALESCE(SUM(amount),0) total FROM payments WHERE status='Paid'").get().total;
 const expenses=db.prepare('SELECT COALESCE(SUM(amount),0) total FROM expenses').get().total;
 const ordersByStatus=db.prepare('SELECT status,COUNT(*) count FROM orders GROUP BY status ORDER BY count DESC').all();
 const pendingPayments=count("SELECT COUNT(*) count FROM payments WHERE status IN ('Pending','Processing')");
 const activeOrders=count("SELECT COUNT(*) count FROM orders WHERE status NOT IN ('Delivered','Cancelled')");
 const openComplaints=count("SELECT COUNT(*) count FROM customer_complaints WHERE status IN ('Open','In progress')");
 const lowStock=count('SELECT COUNT(*) count FROM inventory_items WHERE quantity<=low_stock');
 const staffOnline=count('SELECT COUNT(*) count FROM staff_accounts WHERE active=1');
 const ridersOnline=count('SELECT COUNT(*) count FROM riders WHERE active=1 AND online=1');
 const unread=count("SELECT COUNT(*) count FROM notifications WHERE audience='admin' AND is_read=0");
 const attendanceToday=db.prepare("SELECT COUNT(*) count FROM staff_attendance WHERE attendance_date=date('now') AND check_in IS NOT NULL").get().count;
 const recent=db.prepare('SELECT id,actor,action,details,created_at FROM audit_logs ORDER BY id DESC LIMIT 20').all();
 const security=db.prepare('SELECT id,event,username,ip,details,created_at FROM security_events ORDER BY id DESC LIMIT 20').all();
 res.json({summary:{customers:count('SELECT COUNT(*) count FROM customers'),orders:count('SELECT COUNT(*) count FROM orders'),active_orders:activeOrders,paid_amount:Number(paid),expenses:Number(expenses),estimated_balance:Number(paid)-Number(expenses),pending_payments:pendingPayments,staff_accounts:staffOnline,active_riders:count('SELECT COUNT(*) count FROM riders WHERE active=1'),online_riders:ridersOnline,menu_items:count('SELECT COUNT(*) count FROM menu_items WHERE active=1'),inventory_items:count('SELECT COUNT(*) count FROM inventory_items'),low_stock:lowStock,open_complaints:openComplaints,unread_notifications:unread,staff_checked_in_today:Number(attendanceToday)},orders_by_status:ordersByStatus,recent_activity:recent,security_events:security});
});
app.get('/api/admin/finance',adminOnly,(req,res)=>{const revenue=db.prepare("SELECT COALESCE(SUM(total-discount_amount+tax_amount+delivery_fee),0) total FROM orders WHERE status!='Cancelled' AND (payment_status='Paid' OR (payment_method='Cash on delivery' AND status='Delivered'))").get().total;const expenses=db.prepare('SELECT COALESCE(SUM(amount),0) total FROM expenses').get().total;res.json({revenue,expenses,estimated_profit:revenue-expenses});});
// Extended restaurant controls: refunds, tax, staff accounts/attendance, recipes, wastage, complaints and backups.
app.get('/api/admin/advanced/summary',adminOnly,(req,res)=>{
 const low=db.prepare('SELECT COUNT(*) count FROM inventory_items WHERE quantity<=low_stock').get().count;
 const refunds=db.prepare("SELECT COUNT(*) count,COALESCE(SUM(amount),0) amount FROM refunds WHERE status IN ('Requested','Approved','Processing')").get();
 const complaints=db.prepare("SELECT COUNT(*) count FROM customer_complaints WHERE status IN ('Open','In progress')").get().count;
 res.json({low_stock:low,pending_refunds:refunds.count,refund_amount:refunds.amount,open_complaints:complaints});
});
app.get('/api/admin/refunds',adminOnly,(req,res)=>res.json({refunds:db.prepare('SELECT r.*,p.method,p.status payment_status,p.provider_transaction_id,c.name customer_name FROM refunds r JOIN payments p ON p.id=r.payment_id LEFT JOIN customers c ON c.id=(SELECT customer_id FROM orders WHERE id=r.order_id) ORDER BY r.id DESC LIMIT 300').all()}));
app.post('/api/admin/refunds',adminOnly,(req,res)=>{
 const paymentId=Number(req.body.payment_id),amount=Number(req.body.amount),reason=String(req.body.reason||'').trim().slice(0,300);
 const payment=db.prepare('SELECT * FROM payments WHERE id=?').get(paymentId); if(!payment)return res.status(404).json({error:'Payment not found.'});
 if(payment.status!=='Paid')return res.status(400).json({error:'Only confirmed payments can be refunded.'});
 if(!Number.isSafeInteger(amount)||amount<1||amount>payment.amount||!reason)return res.status(400).json({error:'Enter a valid refund amount and reason.'});
 const prior=db.prepare("SELECT COALESCE(SUM(amount),0) amount FROM refunds WHERE payment_id=? AND status NOT IN ('Rejected','Cancelled')").get(paymentId).amount;
 if(prior+amount>payment.amount)return res.status(400).json({error:'Total refunds cannot exceed the original payment.'});
 const r=db.prepare('INSERT INTO refunds(payment_id,order_id,amount,reason) VALUES(?,?,?,?)').run(paymentId,payment.order_id,amount,reason);
 db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run('admin','refund_requested',`Refund #${r.lastInsertRowid} for payment #${paymentId}: UGX ${amount}`);
 res.json({ok:true,id:r.lastInsertRowid,message:'Refund request recorded. Complete the actual refund in your payment provider account, then update its status.'});
});
app.post('/api/admin/refunds/:id/process-flutterwave',adminOnly,async(req,res)=>{
 const refund=db.prepare('SELECT * FROM refunds WHERE id=?').get(Number(req.params.id));
 if(!refund)return res.status(404).json({error:'Refund request not found.'});
 if(refund.status!=='Approved')return res.status(409).json({error:'Approve the refund request before sending it to Flutterwave.'});
 if(!FLW_SECRET_KEY)return res.status(503).json({error:'Flutterwave is not configured. Add the merchant secret key in the secure hosting environment.'});
 const payment=db.prepare('SELECT * FROM payments WHERE id=?').get(refund.payment_id);
 if(!payment||payment.status!=='Paid'||!payment.provider_transaction_id)return res.status(400).json({error:'This refund does not have a confirmed Flutterwave transaction ID. Use the provider dashboard for manual refunds.'});
 if(!['MTN Mobile Money','Airtel Money','Visa/Mastercard'].includes(payment.method))return res.status(400).json({error:'Automatic refunds are only available for Flutterwave Mobile Money and card payments.'});
 if(refund.provider_reference||refund.status==='Processing')return res.status(409).json({error:'This refund has already been submitted or has a provider reference. Check the Flutterwave dashboard before retrying.'});
 try{
  const response=await fetch(`https://api.flutterwave.com/v3/transactions/${encodeURIComponent(payment.provider_transaction_id)}/refund`,{method:'POST',headers:{Authorization:`Bearer ${FLW_SECRET_KEY}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({amount:refund.amount})});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||data.status!=='success')return res.status(502).json({error:String(data.message||'Flutterwave did not accept the refund request. Check the provider dashboard before trying again.')});
  const providerRef=String(data.data?.id||data.data?.reference||'').slice(0,120);
  db.prepare("UPDATE refunds SET status='Processing',provider_reference=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(providerRef||'Submitted to Flutterwave; awaiting provider confirmation',refund.id);
  db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run('flutterwave','refund_submitted',`Refund #${refund.id} for UGX ${refund.amount} submitted to Flutterwave; provider reference ${providerRef||'pending'}`);
  notify('admin',null,'Refund submitted',`Refund #${refund.id} was submitted to Flutterwave and is awaiting provider confirmation.`,refund.order_id);
  res.json({ok:true,status:'Processing',provider_reference:providerRef,message:'Flutterwave accepted the refund request. Check the provider dashboard for final settlement; do not mark it Completed until confirmed.'});
 }catch(error){console.error('Flutterwave refund request failed:',error.message);res.status(502).json({error:'Could not contact Flutterwave. Check the provider dashboard before retrying to avoid a duplicate refund.'});}
});
app.patch('/api/admin/refunds/:id',adminOnly,(req,res)=>{const status=String(req.body.status||'');if(!['Requested','Approved','Processing','Completed','Rejected','Cancelled'].includes(status))return res.status(400).json({error:'Invalid refund status.'});const ref=String(req.body.provider_reference||'').trim().slice(0,120);const item=db.prepare('SELECT * FROM refunds WHERE id=?').get(Number(req.params.id));if(!item)return res.status(404).json({error:'Refund not found.'});if(status==='Completed'&&!ref)return res.status(400).json({error:'Enter the actual provider refund reference before marking completed.'});db.prepare('UPDATE refunds SET status=?,provider_reference=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status,ref,item.id);db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run('admin','refund_status',`Refund #${item.id} set to ${status}`);res.json({ok:true});});
app.get('/api/admin/tax-settings',adminOnly,(req,res)=>{const r=db.prepare("SELECT value FROM app_settings WHERE key='tax_percent'").get();res.json({tax_percent:r?Number(r.value):0});});
app.put('/api/admin/tax-settings',adminOnly,(req,res)=>{const n=Number(req.body.tax_percent);if(!Number.isFinite(n)||n<0||n>30)return res.status(400).json({error:'Tax rate must be between 0 and 30 percent.'});db.prepare("INSERT INTO app_settings(key,value) VALUES('tax_percent',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(n));db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run('admin','tax_settings',`Tax rate changed to ${n}%`);res.json({ok:true,tax_percent:n,note:'Tax is applied to new customer orders after any discount and before delivery fees. Existing orders are unchanged.'});});
app.get('/api/admin/staff-accounts',adminOnly,(req,res)=>res.json({accounts:db.prepare('SELECT a.id,a.staff_record_id,a.username,a.role,a.permissions_json,a.active,a.created_at,s.name,s.phone FROM staff_accounts a LEFT JOIN staff_records s ON s.id=a.staff_record_id ORDER BY a.id DESC').all()}));
app.post('/api/admin/staff-accounts',adminOnly,async(req,res)=>{const staffId=Number(req.body.staff_record_id),username=String(req.body.username||'').trim(),password=String(req.body.password||''),role=String(req.body.role||'').trim();const allowed=['Manager','Cashier','Chef','Inventory','Customer support','Kitchen supervisor','Delivery coordinator','Marketing','Branch manager','Finance'];const staff=db.prepare('SELECT id FROM staff_records WHERE id=? AND active=1').get(staffId);if(!staff||!/^[A-Za-z0-9._-]{3,40}$/.test(username)||password.length<10||!allowed.includes(role))return res.status(400).json({error:'Choose an active staff member, valid username, role and password of at least 10 characters.'});const permissions=Array.isArray(req.body.permissions)?req.body.permissions.filter(x=>['orders','menu','customers','inventory','reports','payments','kitchen','promotions','riders','support','suppliers','branches'].includes(x)):[];try{db.prepare('INSERT INTO staff_accounts(staff_record_id,username,password_hash,role,permissions_json) VALUES(?,?,?,?,?)').run(staffId,username,await bcrypt.hash(password,12),role,JSON.stringify(permissions));db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run('admin','staff_account_create',`Created ${role} account ${username}`);res.json({ok:true});}catch(e){res.status(409).json({error:'That staff username is already in use.'});}});
app.post('/api/staff/login',async(req,res)=>{const username=String(req.body.username||'').trim(),password=String(req.body.password||'');const a=db.prepare('SELECT * FROM staff_accounts WHERE username=? AND active=1').get(username);if(!a||!(await bcrypt.compare(password,a.password_hash))){try{db.prepare('INSERT INTO security_events(event,username,ip,details) VALUES(?,?,?,?)').run('staff_login_failed',username,String(req.ip||'').slice(0,80),'Invalid staff credentials');}catch(_){}return res.status(401).json({error:'Invalid staff username or password.'});}req.session.regenerate(err=>{if(err)return res.status(500).json({error:'Could not start staff session.'});req.session.staffId=a.id;req.session.isAdmin=false;req.session.customerId=null;req.session.riderId=null;req.session.save(e=>{if(e)return res.status(500).json({error:'Could not save staff session.'});try{db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run('staff:'+a.username,'staff_login',`Staff member signed in with role ${a.role}.`);db.prepare('INSERT INTO security_events(event,username,ip,details) VALUES(?,?,?,?)').run('staff_login_success',a.username,String(req.ip||'').slice(0,80),`Successful staff sign-in (${a.role})`);}catch(_){}res.json({ok:true,role:a.role,permissions:JSON.parse(a.permissions_json||'[]')});});});});
app.get('/api/staff/session',(req,res)=>{if(!req.session.staffId)return res.json({authenticated:false});const a=db.prepare('SELECT id,username,role,permissions_json,active,staff_record_id FROM staff_accounts WHERE id=?').get(req.session.staffId);if(!a||!a.active){req.session.staffId=null;return res.json({authenticated:false});}const person=db.prepare('SELECT name FROM staff_records WHERE id=?').get(a.staff_record_id);res.json({authenticated:true,id:a.id,staff_record_id:a.staff_record_id,name:person?.name||a.username,username:a.username,role:a.role,permissions:JSON.parse(a.permissions_json||'[]')});});
function staffAccount(req){if(!req.session.staffId)return null;const a=db.prepare('SELECT * FROM staff_accounts WHERE id=? AND active=1').get(req.session.staffId);return a||null;}
function staffPermissions(a){try{return JSON.parse(a.permissions_json||'[]')}catch(_){return []}}
app.get('/api/staff/workspace',(req,res)=>{
 const a=staffAccount(req);if(!a)return res.status(401).json({error:'Staff sign-in required.'});
 const permissions=staffPermissions(a),data={role:a.role,username:a.username,permissions,sections:{}};
 const has=p=>permissions.includes(p);
 if(has('orders')||has('kitchen'))data.sections.orders=db.prepare("SELECT o.id,o.status,o.total,o.delivery_address,o.notes,o.created_at,o.scheduled_for,c.name customer_name,c.phone customer_phone,o.items_json FROM orders o LEFT JOIN customers c ON c.id=o.customer_id ORDER BY o.id DESC LIMIT 100").all().map(o=>({...o,items:(()=>{try{return JSON.parse(o.items_json||'[]')}catch(_){return []}})()}));
 if(has('menu'))data.sections.menu=db.prepare('SELECT id,name,category,price,active FROM menu_items ORDER BY category,name').all();
 if(has('customers'))data.sections.customers=db.prepare('SELECT id,name,email,phone,created_at FROM customers ORDER BY id DESC LIMIT 200').all();
 if(has('inventory'))data.sections.inventory=db.prepare('SELECT id,name,unit,quantity,low_stock,unit_cost,updated_at FROM inventory_items ORDER BY name').all();
 if(has('payments'))data.sections.payments=db.prepare('SELECT p.id,p.order_id,p.method,p.amount,p.status,p.provider_reference,p.created_at,c.name customer_name FROM payments p LEFT JOIN customers c ON c.id=p.customer_id ORDER BY p.id DESC LIMIT 150').all();
 if(has('reports'))data.sections.reports={orders:db.prepare('SELECT COUNT(*) count FROM orders').get().count,revenue:db.prepare("SELECT COALESCE(SUM(total),0) total FROM orders WHERE status!='Cancelled'").get().total,delivered:db.prepare("SELECT COUNT(*) count FROM orders WHERE status='Delivered'").get().count};
 if(has('promotions'))data.sections.promotions=db.prepare('SELECT id,title,discount_percent,active,created_at FROM promotions ORDER BY id DESC').all();
 if(has('riders'))data.sections.riders=db.prepare('SELECT id,name,phone,active,username FROM riders ORDER BY name').all();
 if(has('support'))data.sections.support=db.prepare("SELECT id,subject,message,status,created_at,order_id FROM customer_complaints ORDER BY id DESC LIMIT 100").all();
 if(has('suppliers'))data.sections.suppliers=db.prepare('SELECT id,name,phone,email,active FROM suppliers ORDER BY name').all();
 if(has('branches'))data.sections.branches=db.prepare('SELECT id,name,address,phone,active FROM branches ORDER BY name').all();
 db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run('staff:'+a.username,'staff_workspace_view',`Viewed assigned sections: ${permissions.join(', ')}`);
 res.json(data);
});
app.post('/api/staff/orders/:id/status',(req,res)=>{const a=staffAccount(req);if(!a)return res.status(401).json({error:'Staff sign-in required.'});const perms=staffPermissions(a);if(!perms.includes('orders')&&!perms.includes('kitchen'))return res.status(403).json({error:'Your account is not allowed to manage orders.'});const status=String(req.body.status||'');const allowed=['Confirmed','Preparing','Ready for delivery'];if(!allowed.includes(status))return res.status(400).json({error:'This staff role cannot set that order status.'});const id=Number(req.params.id),order=db.prepare('SELECT id,status FROM orders WHERE id=?').get(id);if(!order)return res.status(404).json({error:'Order not found.'});const transitions={Received:'Confirmed',Confirmed:'Preparing',Preparing:'Ready for delivery'};if(transitions[order.status]!==status)return res.status(409).json({error:`Order must move from ${order.status} to the next preparation stage.`});db.prepare('UPDATE orders SET status=? WHERE id=?').run(status,id);db.prepare('INSERT INTO order_events(order_id,actor,event,details) VALUES(?,?,?,?)').run(id,'staff:'+a.username,status,`Updated by ${a.role}`);db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run('staff:'+a.username,'order_status',`Order #${id} changed to ${status}`);const o=db.prepare('SELECT customer_id FROM orders WHERE id=?').get(id);if(o)notify('customer',o.customer_id,'Order update',`Your order #${id} is now ${status}.`,id);notify('admin',null,'Staff updated an order',`${a.username} (${a.role}) moved order #${id} to ${status}.`,id);res.json({ok:true});});
app.post('/api/staff/logout',(req,res)=>{req.session.destroy(err=>{res.clearCookie('connect.sid',{path:'/'});if(err)return res.status(500).json({error:'Could not sign out.'});res.json({ok:true});});});
app.patch('/api/admin/staff-accounts/:id',adminOnly,(req,res)=>{const id=Number(req.params.id),item=db.prepare('SELECT * FROM staff_accounts WHERE id=?').get(id);if(!item)return res.status(404).json({error:'Staff account not found.'});const active=req.body.active===undefined?item.active:(req.body.active?1:0);const role=req.body.role===undefined?item.role:String(req.body.role);const allowedRoles=['Manager','Cashier','Chef','Inventory','Customer support','Kitchen supervisor','Delivery coordinator','Marketing','Branch manager','Finance'];const allowedPermissions=['orders','menu','customers','inventory','reports','payments','kitchen','promotions','riders','support','suppliers','branches'];const permissions=req.body.permissions===undefined?staffPermissions(item):Array.isArray(req.body.permissions)?[...new Set(req.body.permissions.filter(x=>allowedPermissions.includes(x)))]:null;if(!allowedRoles.includes(role)||!permissions)return res.status(400).json({error:'Choose a valid role and assigned sections.'});db.prepare('UPDATE staff_accounts SET active=?,role=?,permissions_json=? WHERE id=?').run(active,role,JSON.stringify(permissions),id);db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run('admin','staff_account_update',`Staff account #${id}: ${role}; ${active?'enabled':'disabled'}; sections ${permissions.join(', ')}`);res.json({ok:true});});
app.get('/api/admin/attendance',adminOnly,(req,res)=>res.json({attendance:db.prepare('SELECT a.*,s.name,s.role FROM staff_attendance a JOIN staff_records s ON s.id=a.staff_record_id ORDER BY attendance_date DESC,id DESC LIMIT 300').all()}));
app.post('/api/admin/attendance',adminOnly,(req,res)=>{const id=Number(req.body.staff_record_id),date=String(req.body.attendance_date||new Date().toISOString().slice(0,10)),action=String(req.body.action||'check_in');if(!db.prepare('SELECT id FROM staff_records WHERE id=?').get(id)||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!['check_in','check_out'].includes(action))return res.status(400).json({error:'Select a staff member, valid date and attendance action.'});if(action==='check_in')db.prepare('INSERT INTO staff_attendance(staff_record_id,attendance_date,check_in) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(staff_record_id,attendance_date) DO UPDATE SET check_in=COALESCE(check_in,CURRENT_TIMESTAMP)').run(id,date);else db.prepare('UPDATE staff_attendance SET check_out=CURRENT_TIMESTAMP WHERE staff_record_id=? AND attendance_date=?').run(id,date);db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run('admin','staff_attendance',`${action} recorded for staff #${id} on ${date}`);res.json({ok:true});});
app.get('/api/admin/recipes',adminOnly,(req,res)=>res.json({recipes:db.prepare('SELECT r.*,m.name menu_name,i.name inventory_name,i.unit FROM stock_recipes r JOIN menu_items m ON m.id=r.menu_item_id JOIN inventory_items i ON i.id=r.inventory_item_id ORDER BY m.name,i.name').all()}));
app.post('/api/admin/recipes',adminOnly,(req,res)=>{const menu=Number(req.body.menu_item_id),item=Number(req.body.inventory_item_id),qty=Number(req.body.quantity);if(!db.prepare('SELECT id FROM menu_items WHERE id=?').get(menu)||!db.prepare('SELECT id FROM inventory_items WHERE id=?').get(item)||!Number.isFinite(qty)||qty<=0)return res.status(400).json({error:'Choose a menu item, ingredient and positive quantity.'});db.prepare('INSERT INTO stock_recipes(menu_item_id,inventory_item_id,quantity) VALUES(?,?,?) ON CONFLICT(menu_item_id,inventory_item_id) DO UPDATE SET quantity=excluded.quantity').run(menu,item,qty);res.json({ok:true});});
app.delete('/api/admin/recipes/:id',adminOnly,(req,res)=>{db.prepare('DELETE FROM stock_recipes WHERE id=?').run(Number(req.params.id));res.json({ok:true});});
app.post('/api/admin/wastage',adminOnly,(req,res)=>{const item=Number(req.body.inventory_item_id),qty=Number(req.body.quantity),reason=String(req.body.reason||'').trim().slice(0,200),row=db.prepare('SELECT * FROM inventory_items WHERE id=?').get(item);if(!row||!Number.isFinite(qty)||qty<=0||qty>row.quantity||!reason)return res.status(400).json({error:'Select an item and enter a valid wastage quantity and reason.'});db.transaction(()=>{db.prepare('UPDATE inventory_items SET quantity=quantity-?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(qty,item);db.prepare('INSERT INTO stock_wastage(inventory_item_id,quantity,reason) VALUES(?,?,?)').run(item,qty,reason);db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run('admin','stock_wastage',`${qty} ${row.unit} of ${row.name}: ${reason}`);})();res.json({ok:true});});
app.get('/api/admin/complaints',adminOnly,(req,res)=>res.json({complaints:db.prepare('SELECT x.*,c.name customer_name,c.phone customer_phone FROM customer_complaints x LEFT JOIN customers c ON c.id=x.customer_id ORDER BY x.id DESC LIMIT 300').all()}));
app.post('/api/admin/complaints',adminOnly,(req,res)=>{const subject=String(req.body.subject||'').trim().slice(0,120),message=String(req.body.message||'').trim().slice(0,1000),customer=req.body.customer_id?Number(req.body.customer_id):null,order=req.body.order_id?Number(req.body.order_id):null;if(!subject||!message)return res.status(400).json({error:'Enter a complaint subject and details.'});const r=db.prepare('INSERT INTO customer_complaints(customer_id,order_id,subject,message) VALUES(?,?,?,?)').run(customer,order,subject,message);res.json({ok:true,id:r.lastInsertRowid});});
app.patch('/api/admin/complaints/:id',adminOnly,(req,res)=>{const status=String(req.body.status||'');if(!['Open','In progress','Resolved','Closed'].includes(status))return res.status(400).json({error:'Invalid complaint status.'});db.prepare('UPDATE customer_complaints SET status=?,admin_note=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status,String(req.body.admin_note||'').slice(0,1000),Number(req.params.id));res.json({ok:true});});
app.get('/api/admin/orders/:id/receipt',adminOnly,(req,res)=>{const o=db.prepare('SELECT o.*,c.name customer_name,c.phone customer_phone FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=?').get(Number(req.params.id));if(!o)return res.status(404).json({error:'Order not found.'});let items=[];try{items=JSON.parse(o.items_json)}catch(_){};res.json({receipt:{order_id:o.id,customer:o.customer_name,phone:o.customer_phone,address:o.delivery_address,items,total:o.total,delivery_fee:o.delivery_fee,payment_method:o.payment_method,payment_status:o.payment_status,status:o.status,created_at:o.created_at,scheduled_for:o.scheduled_for,currency:'UGX'}});});
app.post('/api/admin/orders/:id/cancel',adminOnly,(req,res)=>{const reason=String(req.body.reason||'').trim().slice(0,300);const id=Number(req.params.id),o=db.prepare('SELECT * FROM orders WHERE id=?').get(id);if(!o)return res.status(404).json({error:'Order not found.'});if(o.status==='Delivered')return res.status(400).json({error:'Delivered orders cannot be cancelled.'});if(o.status==='Cancelled')return res.status(409).json({error:'Order is already cancelled.'});if(!reason)return res.status(400).json({error:'Enter a cancellation reason.'});db.transaction(()=>{db.prepare("UPDATE orders SET status='Cancelled' WHERE id=?").run(id);db.prepare('INSERT INTO order_events(order_id,actor,event,details) VALUES(?,?,?,?)').run(id,'admin','cancelled',reason);notify('customer',o.customer_id,'Order cancelled',`Order #${id} was cancelled: ${reason}`,id);db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run('admin','order_cancel',`Order #${id}: ${reason}`);})();res.json({ok:true});});
app.get('/api/admin/backup',adminOnly,(req,res)=>{const bytes=Buffer.from(rawDb.export());res.setHeader('Content-Type','application/vnd.sqlite3');res.setHeader('Content-Disposition',`attachment; filename="eddys-kitchen-backup-${new Date().toISOString().slice(0,10)}.db"`);res.send(bytes);});
app.post('/api/admin/backup/restore',adminOnly,(req,res)=>{const encoded=String(req.body.database_base64||'');if(!encoded||encoded.length>50*1024*1024)return res.status(400).json({error:'Provide a valid database backup under 35 MB.'});let candidate;try{const bytes=Buffer.from(encoded,'base64');candidate=new SQL.Database(new Uint8Array(bytes));const check=candidate.exec('PRAGMA quick_check')?.[0]?.values?.[0]?.[0];const required=['admins','customers','orders','payments','menu_items','inventory_items','audit_logs','app_settings'];const present=candidate.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values?.map(x=>x[0])||[];if(String(check).toLowerCase()!=='ok'||required.some(t=>!present.includes(t)))throw new Error('Backup integrity/schema check failed or required tables are missing.');}catch(e){return res.status(400).json({error:'Backup could not be validated: '+e.message});}try{const previous=rawDb;rawDb=candidate;try{persist();}catch(e){rawDb=previous;throw e;}db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run('admin','database_restore','Database restored from a validated backup');res.json({ok:true,message:'Database restored. Sign in again if the restored session has expired.'});}catch(e){console.error(e);res.status(500).json({error:'Database restore failed safely: '+e.message});}});
app.get('/api/admin/reports/export.csv',adminOnly,(req,res)=>{const rows=db.prepare("SELECT o.id,date(o.created_at) date,c.name customer,o.status,o.payment_method,o.payment_status,o.total,o.discount_amount,o.discount_code,o.tax_amount,o.delivery_fee FROM orders o JOIN customers c ON c.id=o.customer_id ORDER BY o.id DESC").all();const esc=v=>'"'+String(v??'').replace(/"/g,'""')+'"';const csv=['Order,Date,Customer,Status,Payment method,Payment status,Subtotal,Discount,Discount code,Tax,Delivery fee',...rows.map(r=>[r.id,r.date,r.customer,r.status,r.payment_method,r.payment_status,r.total,r.discount_amount,r.discount_code,r.tax_amount,r.delivery_fee].map(esc).join(','))].join('\n');res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="eddys-kitchen-orders-report.csv"');res.send(csv);});
app.get('/api/public-settings',(req,res)=>{const rows=db.prepare('SELECT key,value FROM app_settings').all();const all=Object.fromEntries(rows.map(r=>[r.key,r.value]));const keys=['business_name','business_phone','social_facebook','social_instagram','social_tiktok','social_youtube','social_whatsapp','payment_receiver_name','mtn_payment_number','airtel_payment_number','bank_payment_details','payment_instructions','opening_hours','minimum_order_amount','delivery_zones','restaurant_lat','restaurant_lng','business_email','business_address','business_description','operating_days','footer_message','brand_primary_color','brand_accent_color','pickup_enabled','scheduled_orders_enabled','prep_time_minutes','delivery_fee','free_delivery_minimum','max_delivery_km','delivery_radius_km','footer_message'];const settings={business_name:'Eddys Kitchen',business_phone:''};for(const k of keys)if(all[k])settings[k]=all[k];settings.online_payments_enabled=!!(FLW_SECRET_KEY&&APP_BASE_URL);res.json({settings});});
app.get('/api/admin/settings',adminOnly,(req,res)=>{const rows=db.prepare('SELECT key,value FROM app_settings').all();const settings={delivery_fee:'0',free_delivery_minimum:'0',business_phone:'',business_name:'Eddys Kitchen',currency:'UGX',social_facebook:'',social_instagram:'',social_tiktok:'',social_youtube:'',social_whatsapp:'',payment_receiver_name:'',mtn_payment_number:'',airtel_payment_number:'',bank_payment_details:'',payment_instructions:'Pay to the business account shown for your selected method. Keep your transaction ID.',opening_hours:'09:00-21:00',minimum_order_amount:'0',delivery_zones:'',restaurant_lat:'',restaurant_lng:'',business_email:'',business_address:'',business_description:'',operating_days:'Monday-Sunday',pickup_enabled:'true',max_delivery_km:'20',prep_time_minutes:'30',scheduled_orders_enabled:'true',auto_assign_rider:'false',gps_update_seconds:'10',delivery_radius_km:'15',public_registration_enabled:'true',guest_checkout_enabled:'true',max_daily_orders:'0',auto_confirm_orders:'false',cancellation_window_minutes:'10',notify_customers:'true',notify_riders:'true',notify_admins:'true',email_notifications_enabled:'false',brand_primary_color:'#173f35',brand_accent_color:'#e5b94b',footer_message:'Freshly prepared. Happily delivered.'};rows.forEach(r=>settings[r.key]=r.value);res.json({settings});});
app.put('/api/admin/settings',adminOnly,(req,res)=>{const allowed=['delivery_fee','free_delivery_minimum','business_phone','business_name','social_facebook','social_instagram','social_tiktok','social_youtube','social_whatsapp','payment_receiver_name','mtn_payment_number','airtel_payment_number','bank_payment_details','payment_instructions','opening_hours','minimum_order_amount','delivery_zones','restaurant_lat','restaurant_lng','business_email','business_address','business_description','operating_days','pickup_enabled','max_delivery_km','prep_time_minutes','scheduled_orders_enabled','auto_assign_rider','gps_update_seconds','delivery_radius_km','public_registration_enabled','guest_checkout_enabled','max_daily_orders','auto_confirm_orders','cancellation_window_minutes','notify_customers','notify_riders','notify_admins','email_notifications_enabled','brand_primary_color','brand_accent_color','footer_message'];for(const key of allowed){if(req.body[key]===undefined)continue;let value=String(req.body[key]).trim();if(['delivery_fee','free_delivery_minimum','minimum_order_amount'].includes(key)&&(!/^\d+$/.test(value)||Number(value)>1000000))return res.status(400).json({error:'Delivery amounts must be whole UGX amounts.'});if(key.startsWith('social_')&&value&&!/^https:\/\//i.test(value))return res.status(400).json({error:'Social media links must begin with https://'});if(['restaurant_lat','restaurant_lng'].includes(key)&&value!==''&&!Number.isFinite(Number(value)))return res.status(400).json({error:'Restaurant GPS coordinates must be valid numbers.'});if(key==='restaurant_lat'&&value!==''&&(Math.abs(Number(value))>90))return res.status(400).json({error:'Restaurant latitude must be between -90 and 90.'});if(key==='restaurant_lng'&&value!==''&&(Math.abs(Number(value))>180))return res.status(400).json({error:'Restaurant longitude must be between -180 and 180.'});if(['pickup_enabled','scheduled_orders_enabled','auto_assign_rider','public_registration_enabled','guest_checkout_enabled','auto_confirm_orders','notify_customers','notify_riders','notify_admins','email_notifications_enabled'].includes(key)&&!['true','false'].includes(value))return res.status(400).json({error:'Choose a valid enabled/disabled setting.'});if(['max_delivery_km','prep_time_minutes','gps_update_seconds','delivery_radius_km','max_daily_orders','cancellation_window_minutes'].includes(key)&&value!==''&&(!Number.isFinite(Number(value))||Number(value)<0||Number(value)>10000))return res.status(400).json({error:'Enter a valid non-negative number for '+key+'.'});if(['brand_primary_color','brand_accent_color'].includes(key)&&!/^#[0-9a-f]{6}$/i.test(value))return res.status(400).json({error:'Brand colours must be six-digit hexadecimal colours.'});if(key==='business_email'&&value&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))return res.status(400).json({error:'Enter a valid business email address.'});value=value.slice(0,500);db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);}db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run('admin','settings_updated','Business settings updated from admin Settings page');res.json({ok:true});});
app.get('/api/admin/reports',adminOnly,(req,res)=>{const days=db.prepare("SELECT date(created_at) day,COUNT(*) orders,COALESCE(SUM(total-discount_amount+tax_amount+delivery_fee),0) gross FROM orders GROUP BY date(created_at) ORDER BY day DESC LIMIT 30").all();const delivery=db.prepare("SELECT r.id,r.name,COUNT(o.id) deliveries,COALESCE(SUM(CASE WHEN o.status='Delivered' THEN o.delivery_fee ELSE 0 END),0) earnings FROM riders r LEFT JOIN orders o ON o.rider_id=r.id GROUP BY r.id ORDER BY r.name").all();res.json({days,delivery});});

app.get('/api/admin/riders',adminOnly,(req,res)=>{
 db.prepare("UPDATE riders SET online=0 WHERE online=1 AND (last_seen IS NULL OR last_seen<datetime('now','-2 minutes'))").run();
 const riders=db.prepare(`SELECT r.id,r.name,r.phone,r.username,r.active,r.online,r.last_seen,r.vehicle_type,r.vehicle_registration,r.emergency_contact,r.created_at,
  (SELECT COUNT(*) FROM orders o WHERE o.rider_id=r.id AND o.status='Delivered') completed_deliveries,
  (SELECT COUNT(*) FROM orders o WHERE o.rider_id=r.id AND o.status NOT IN ('Delivered','Cancelled')) active_deliveries,
  (SELECT COALESCE(SUM(o.delivery_fee),0) FROM orders o WHERE o.rider_id=r.id AND o.status='Delivered') completed_delivery_fees
  FROM riders r ORDER BY r.active DESC,r.online DESC,r.name`).all();
 res.json({riders});
});
app.post('/api/admin/riders',adminOnly,async(req,res)=>{
  const name=String(req.body.name||'').trim().slice(0,100), phone=String(req.body.phone||'').trim().slice(0,40), username=String(req.body.username||'').trim().toLowerCase().slice(0,60), password=String(req.body.password||'');
  const vehicleType=String(req.body.vehicle_type||'').trim().slice(0,50),vehicleRegistration=String(req.body.vehicle_registration||'').trim().slice(0,40),emergencyContact=String(req.body.emergency_contact||'').trim().slice(0,40);
  if(name.length<2||phone.length<7||!/^[a-z0-9._-]{3,60}$/.test(username)||password.length<10) return res.status(400).json({error:'Enter a name, phone number, username (3+ letters/numbers), and temporary password of at least 10 characters.'});
  try{const hash=await bcrypt.hash(password,12);const r=db.prepare('INSERT INTO riders(name,phone,username,password_hash,vehicle_type,vehicle_registration,emergency_contact) VALUES(?,?,?,?,?,?,?)').run(name,phone,username,hash,vehicleType,vehicleRegistration,emergencyContact);db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run('admin','rider_created',`Created rider account ${username}`);res.json({ok:true,id:Number(r.lastInsertRowid)});}catch(e){if(String(e.message).includes('UNIQUE'))return res.status(409).json({error:'That rider username already exists.'});console.error(e);res.status(500).json({error:'Could not create rider account.'});}
});
app.patch('/api/admin/riders/:id',adminOnly,(req,res)=>{
 const id=Number(req.params.id),rider=db.prepare('SELECT * FROM riders WHERE id=?').get(id);if(!rider)return res.status(404).json({error:'Rider not found.'});
 const active=req.body.active===undefined?rider.active:(Number(req.body.active)?1:0);
 const name=req.body.name===undefined?rider.name:String(req.body.name).trim().slice(0,100),phone=req.body.phone===undefined?rider.phone:String(req.body.phone).trim().slice(0,40);
 const vehicleType=req.body.vehicle_type===undefined?rider.vehicle_type:String(req.body.vehicle_type).trim().slice(0,50),vehicleRegistration=req.body.vehicle_registration===undefined?rider.vehicle_registration:String(req.body.vehicle_registration).trim().slice(0,40),emergencyContact=req.body.emergency_contact===undefined?rider.emergency_contact:String(req.body.emergency_contact).trim().slice(0,40);
 if(name.length<2||phone.length<7)return res.status(400).json({error:'Enter a valid rider name and phone number.'});
 db.prepare('UPDATE riders SET name=?,phone=?,vehicle_type=?,vehicle_registration=?,emergency_contact=?,active=?,online=CASE WHEN ?=0 THEN 0 ELSE online END WHERE id=?').run(name,phone,vehicleType,vehicleRegistration,emergencyContact,active,active,id);
 db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run('admin','rider_updated',`Updated rider account #${id}`);res.json({ok:true});
});
app.patch('/api/admin/orders/:id/assign-rider',adminOnly,(req,res)=>{
 const id=Number(req.params.id),riderId=req.body.rider_id===null||req.body.rider_id===''?null:Number(req.body.rider_id);
 if(riderId!==null&&!db.prepare('SELECT id FROM riders WHERE id=? AND active=1 AND online=1').get(riderId))return res.status(400).json({error:'Choose an active rider who is currently online. Ask the rider to sign in and select Go online first.'});
 const order=db.prepare('SELECT id,status,customer_id FROM orders WHERE id=?').get(id);if(!order)return res.status(404).json({error:'Order not found.'});
 if(['Delivered','Cancelled'].includes(order.status))return res.status(409).json({error:'A completed or cancelled order cannot be assigned.'});
 db.prepare("UPDATE orders SET rider_id=?,rider_assignment_status=?,rider_lat=NULL,rider_lng=NULL,rider_updated_at=NULL WHERE id=?").run(riderId,riderId?'Assigned':'Unassigned',id);
 if(riderId!==null){const rr=db.prepare('SELECT name FROM riders WHERE id=?').get(riderId);notify('rider',riderId,'New delivery assigned',`Order #${id} has been assigned to you. Wait until the kitchen marks it ready before collecting it.`,id);notify('customer',order.customer_id,'Rider assigned',`${rr.name} has been assigned to order #${id}. Live location will appear when the rider starts sharing GPS.`,id);}
 db.prepare('INSERT INTO order_events(order_id,actor,event,details) VALUES(?,?,?,?)').run(id,'admin',riderId?'rider_assigned':'rider_unassigned',riderId?`Assigned rider #${riderId}`:'Rider assignment removed');
 res.json({ok:true});
});
app.get('/api/rider/session',(req,res)=>{if(req.session.riderId)db.prepare("UPDATE riders SET online=0 WHERE id=? AND online=1 AND (last_seen IS NULL OR last_seen<datetime('now','-2 minutes'))").run(req.session.riderId);const rider=req.session.riderId?db.prepare('SELECT id,name,phone,username,active,online,vehicle_type,vehicle_registration,emergency_contact FROM riders WHERE id=?').get(req.session.riderId):null;res.json({authenticated:!!rider&&!!rider.active,rider:rider&&rider.active?rider:null});});
app.post('/api/rider/change-password',riderOnly,async(req,res)=>{const current=String(req.body.currentPassword||''),next=String(req.body.newPassword||'');const row=db.prepare('SELECT password_hash FROM riders WHERE id=?').get(req.rider.id);if(!row||!(await bcrypt.compare(current,row.password_hash)))return res.status(401).json({error:'Current password is incorrect.'});if(next.length<10)return res.status(400).json({error:'New password must contain at least 10 characters.'});db.prepare('UPDATE riders SET password_hash=? WHERE id=?').run(await bcrypt.hash(next,12),req.rider.id);db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run(`rider:${req.rider.id}`,'rider_password_changed','Rider changed their password.');res.json({ok:true,message:'Password changed successfully.'});});
app.patch('/api/rider/availability',riderOnly,(req,res)=>{const online=req.body.online?1:0;db.prepare('UPDATE riders SET online=?,last_seen=CURRENT_TIMESTAMP WHERE id=?').run(online,req.rider.id);db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run(`rider:${req.rider.id}`,'availability_changed',`Rider ${req.rider.name} is ${online?'online':'offline'}`);res.json({ok:true,online:!!online});});
app.post('/api/rider/heartbeat',riderOnly,(req,res)=>{db.prepare('UPDATE riders SET last_seen=CURRENT_TIMESTAMP WHERE id=?').run(req.rider.id);res.json({ok:true});});
app.get('/api/rider/summary',riderOnly,(req,res)=>{const summary=db.prepare(`SELECT COUNT(CASE WHEN status='Delivered' THEN 1 END) completed,COUNT(CASE WHEN status NOT IN ('Delivered','Cancelled') THEN 1 END) active,COUNT(CASE WHEN status='Cancelled' THEN 1 END) cancelled,COALESCE(SUM(CASE WHEN status='Delivered' THEN delivery_fee ELSE 0 END),0) delivery_fees FROM orders WHERE rider_id=?`).get(req.rider.id);res.json({summary});});
app.get('/api/rider/history',riderOnly,(req,res)=>{const rows=db.prepare(`SELECT id,total,delivery_fee,status,delivery_address,created_at,payment_status FROM orders WHERE rider_id=? AND status IN ('Delivered','Cancelled') ORDER BY id DESC LIMIT 100`).all(req.rider.id);res.json({history:rows});});
app.post('/api/rider/orders/:id/acceptance',riderOnly,(req,res)=>{const id=Number(req.params.id),decision=String(req.body.decision||'');if(!['Accepted','Declined'].includes(decision))return res.status(400).json({error:'Choose accept or decline.'});const order=db.prepare("SELECT id,customer_id,status,rider_assignment_status FROM orders WHERE id=? AND rider_id=? AND status NOT IN ('Delivered','Cancelled')").get(id,req.rider.id);if(!order)return res.status(404).json({error:'This order is no longer assigned to you.'});if(order.rider_assignment_status!=='Assigned')return res.status(409).json({error:'This assignment has already been responded to.'});if(decision==='Declined'){db.prepare("UPDATE orders SET rider_id=NULL,rider_assignment_status='Declined',rider_lat=NULL,rider_lng=NULL,rider_updated_at=NULL WHERE id=?").run(id);notify('admin',null,'Rider declined delivery',`${req.rider.name} declined order #${id}. Please assign another rider.`,id);notify('customer',order.customer_id,'Delivery reassignment',`Your order #${id} is being assigned to another rider.`,id);}else{db.prepare("UPDATE orders SET rider_assignment_status='Accepted' WHERE id=?").run(id);notify('admin',null,'Rider accepted delivery',`${req.rider.name} accepted order #${id}.`,id);notify('customer',order.customer_id,'Rider confirmed',`${req.rider.name} accepted delivery #${id}.`,id);}db.prepare('INSERT INTO order_events(order_id,actor,event,details) VALUES(?,?,?,?)').run(id,`rider:${req.rider.id}`,`rider_${decision.toLowerCase()}`,`${req.rider.name} ${decision.toLowerCase()} the delivery.`);res.json({ok:true,decision});});
app.get('/api/rider/notifications',riderOnly,(req,res)=>res.json({notifications:db.prepare("SELECT id,title,message,order_id,is_read,created_at FROM notifications WHERE audience='rider' AND audience_id=? ORDER BY id DESC LIMIT 50").all(req.rider.id)}));
app.patch('/api/rider/notifications/:id/read',riderOnly,(req,res)=>{const r=db.prepare("UPDATE notifications SET is_read=1 WHERE id=? AND audience='rider' AND audience_id=?").run(Number(req.params.id),req.rider.id);if(!r.changes)return res.status(404).json({error:'Notification not found.'});res.json({ok:true});});
app.post('/api/rider/login',async(req,res)=>{const username=String(req.body.username||'').trim().toLowerCase(),password=String(req.body.password||'');const rider=db.prepare('SELECT * FROM riders WHERE username=? AND active=1').get(username);if(!rider||!(await bcrypt.compare(password,rider.password_hash)))return res.status(401).json({error:'Rider username or password is incorrect, or the account is inactive.'});req.session.regenerate(err=>{if(err){console.error('Could not regenerate rider session:',err.message);return res.status(500).json({error:'Could not start a secure rider session.'});}req.session.riderId=rider.id;db.prepare('UPDATE riders SET last_seen=CURRENT_TIMESTAMP WHERE id=?').run(rider.id);req.session.isAdmin=false;req.session.customerId=null;req.session.save(saveErr=>{if(saveErr){console.error('Could not save rider session:',saveErr.message);return res.status(500).json({error:'Could not save rider sign-in.'});}res.json({ok:true,rider:{id:rider.id,name:rider.name,phone:rider.phone,username:rider.username,online:!!rider.online,vehicle_type:rider.vehicle_type||'',vehicle_registration:rider.vehicle_registration||'',emergency_contact:rider.emergency_contact||''}});});});});
app.post('/api/rider/logout',(req,res)=>{if(req.session.riderId)db.prepare('UPDATE riders SET online=0,last_seen=CURRENT_TIMESTAMP WHERE id=?').run(req.session.riderId);req.session.destroy(err=>{res.clearCookie('connect.sid',{path:'/'});if(err)return res.status(500).json({error:'Could not sign out cleanly.'});res.json({ok:true});});});
app.get('/api/rider/orders',riderOnly,(req,res)=>{const orders=db.prepare("SELECT o.id,o.items_json,o.total,o.delivery_address,o.notes,o.status,o.created_at,o.scheduled_for,o.customer_lat,o.customer_lng,o.rider_lat,o.rider_lng,o.rider_updated_at,o.payment_method,o.payment_status,o.delivery_fee,o.discount_amount,o.discount_code,o.tax_amount,o.scheduled_for,o.rider_assignment_status,c.name customer_name,c.phone customer_phone FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.rider_id=? AND o.status NOT IN ('Delivered','Cancelled') ORDER BY o.id DESC").all(req.rider.id);res.json({orders:orders.map(o=>({...o,items:JSON.parse(o.items_json)}))});});
app.patch('/api/rider/orders/:id/status',riderOnly,(req,res)=>{
 const status=String(req.body.status||''),id=Number(req.params.id);
 const order=db.prepare("SELECT id,customer_id,status,total,loyalty_awarded FROM orders WHERE id=? AND rider_id=? AND status NOT IN ('Delivered','Cancelled')").get(id,req.rider.id);
 if(!order)return res.status(404).json({error:'Active order not found in your assigned deliveries.'});
 const nextByCurrent={'Ready for delivery':['On the way'],'On the way':['Delivered']};
 if(status==='On the way'&&db.prepare('SELECT rider_assignment_status FROM orders WHERE id=?').get(id)?.rider_assignment_status!=='Accepted')return res.status(409).json({error:'Accept this delivery assignment before starting the journey.'});
 if(!(nextByCurrent[order.status]||[]).includes(status))return res.status(409).json({error:order.status==='Ready for delivery'?'You can mark this order On the way after collecting it.':'You can mark this order Delivered only after it is On the way.'});
 db.transaction(()=>{
  db.prepare('UPDATE orders SET status=? WHERE id=? AND rider_id=?').run(status,id,req.rider.id);
  db.prepare('INSERT INTO order_events(order_id,actor,event,details) VALUES(?,?,?,?)').run(id,`rider:${req.rider.id}`,status.toLowerCase().replaceAll(' ','_'),`Rider ${req.rider.name} updated the delivery to ${status}`);
  notify('customer',order.customer_id,'Delivery update',`Order #${id}: ${status}.`,id);
  notify('admin',null,'Rider delivery update',`Rider ${req.rider.name} updated order #${id} to ${status}.`,id);
  if(status==='Delivered'&&!order.loyalty_awarded){const rate=Number(db.prepare("SELECT value FROM app_settings WHERE key='loyalty_points_per_1000'").get()?.value||1);const points=Math.floor(Number(order.total)/1000)*rate;if(points>0)db.prepare('UPDATE customers SET loyalty_points=COALESCE(loyalty_points,0)+? WHERE id=?').run(points,order.customer_id);db.prepare('UPDATE orders SET loyalty_awarded=1 WHERE id=?').run(id);}
 });
 if(status==='Delivered')applyRecipeStockDeduction(id);
 res.json({ok:true,status});
});
app.post('/api/rider/orders/:id/location',riderOnly,(req,res)=>{const lat=Number(req.body.lat),lng=Number(req.body.lng);if(!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180)return res.status(400).json({error:'Valid GPS coordinates are required.'});const r=db.prepare("UPDATE orders SET rider_lat=?,rider_lng=?,rider_updated_at=CURRENT_TIMESTAMP WHERE id=? AND rider_id=? AND status NOT IN ('Delivered','Cancelled')").run(lat,lng,Number(req.params.id),req.rider.id);if(!r.changes)return res.status(404).json({error:'Active assigned order not found.'});res.json({ok:true});});
app.get('/api/admin/customers',adminOnly,(req,res)=>res.json({customers:db.prepare('SELECT id,name,email,phone,created_at FROM customers ORDER BY id DESC LIMIT 500').all()}));
// Advanced operations: branches, kitchen queue, suppliers/purchases and customer loyalty.
app.get('/api/admin/branches',adminOnly,(req,res)=>res.json({branches:db.prepare('SELECT * FROM branches ORDER BY active DESC,name').all()}));
app.post('/api/admin/branches',adminOnly,(req,res)=>{const name=String(req.body.name||'').trim().slice(0,100),address=String(req.body.address||'').trim().slice(0,200),phone=String(req.body.phone||'').trim().slice(0,30);if(!name)return res.status(400).json({error:'Branch name is required.'});const r=db.prepare('INSERT INTO branches(name,address,phone) VALUES(?,?,?)').run(name,address,phone);db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run('admin','branch_add',`Created branch ${name}`);res.json({ok:true,id:r.lastInsertRowid});});
app.patch('/api/admin/branches/:id',adminOnly,(req,res)=>{const id=Number(req.params.id),b=db.prepare('SELECT * FROM branches WHERE id=?').get(id);if(!b)return res.status(404).json({error:'Branch not found.'});const active=req.body.active===undefined?b.active:(Number(req.body.active)?1:0);const name=req.body.name===undefined?b.name:String(req.body.name).trim().slice(0,100);const address=req.body.address===undefined?b.address:String(req.body.address).trim().slice(0,200);const phone=req.body.phone===undefined?b.phone:String(req.body.phone).trim().slice(0,30);if(!name)return res.status(400).json({error:'Branch name is required.'});db.prepare('UPDATE branches SET name=?,address=?,phone=?,active=? WHERE id=?').run(name,address,phone,active,id);res.json({ok:true});});
app.get('/api/admin/kitchen',adminOnly,(req,res)=>{const rows=db.prepare("SELECT o.id,o.items_json,o.status,o.notes,o.created_at,o.scheduled_for,o.branch_id,c.name customer_name,c.phone customer_phone,b.name branch_name FROM orders o JOIN customers c ON c.id=o.customer_id LEFT JOIN branches b ON b.id=o.branch_id WHERE o.status IN ('Received','Confirmed','Preparing','Ready for delivery') ORDER BY CASE o.status WHEN 'Received' THEN 0 WHEN 'Confirmed' THEN 1 WHEN 'Preparing' THEN 2 ELSE 3 END,o.id ASC LIMIT 200").all();res.json({orders:rows.map(o=>({...o,items:JSON.parse(o.items_json)}))});});
app.patch('/api/admin/orders/:id/branch',adminOnly,(req,res)=>{const id=Number(req.params.id),branchId=req.body.branch_id===null||req.body.branch_id===''?null:Number(req.body.branch_id);if(branchId!==null&&!db.prepare('SELECT id FROM branches WHERE id=? AND active=1').get(branchId))return res.status(400).json({error:'Choose an active branch.'});const r=db.prepare('UPDATE orders SET branch_id=? WHERE id=?').run(branchId,id);if(!r.changes)return res.status(404).json({error:'Order not found.'});res.json({ok:true});});
app.get('/api/admin/suppliers',adminOnly,(req,res)=>res.json({suppliers:db.prepare('SELECT * FROM suppliers ORDER BY active DESC,name').all(),purchases:db.prepare('SELECT p.*,s.name supplier_name,i.name item_name,i.unit FROM stock_purchases p LEFT JOIN suppliers s ON s.id=p.supplier_id JOIN inventory_items i ON i.id=p.item_id ORDER BY p.id DESC LIMIT 100').all()}));
app.post('/api/admin/suppliers',adminOnly,(req,res)=>{const name=String(req.body.name||'').trim().slice(0,100);if(!name)return res.status(400).json({error:'Supplier name is required.'});const r=db.prepare('INSERT INTO suppliers(name,phone,email,notes) VALUES(?,?,?,?)').run(name,String(req.body.phone||'').slice(0,30),String(req.body.email||'').slice(0,120),String(req.body.notes||'').slice(0,300));res.json({ok:true,id:r.lastInsertRowid});});
app.post('/api/admin/purchases',adminOnly,(req,res)=>{const supplierId=req.body.supplier_id?Number(req.body.supplier_id):null,itemId=Number(req.body.item_id),qty=Number(req.body.quantity),cost=Number(req.body.unit_cost);const item=db.prepare('SELECT * FROM inventory_items WHERE id=?').get(itemId);if(!item||!Number.isFinite(qty)||qty<=0||!Number.isSafeInteger(cost)||cost<0)return res.status(400).json({error:'Choose an inventory item and enter valid quantity and unit cost.'});if(supplierId!==null&&!db.prepare('SELECT id FROM suppliers WHERE id=?').get(supplierId))return res.status(400).json({error:'Supplier not found.'});const total=Math.round(qty*cost);db.transaction(()=>{db.prepare('INSERT INTO stock_purchases(supplier_id,item_id,quantity,unit_cost,total_cost,notes) VALUES(?,?,?,?,?,?)').run(supplierId,itemId,qty,cost,total,String(req.body.notes||'').slice(0,300));db.prepare('UPDATE inventory_items SET quantity=quantity+?,unit_cost=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(qty,cost,itemId);db.prepare('INSERT INTO expenses(title,category,amount,notes) VALUES(?,?,?,?)').run(`Stock purchase: ${item.name}`,'Ingredients',total,String(req.body.notes||'Supplier purchase'));db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run('admin','stock_purchase',`Purchased ${qty} ${item.unit} of ${item.name} for UGX ${total}`);})();res.json({ok:true,total});});
app.get('/api/admin/loyalty',adminOnly,(req,res)=>res.json({customers:db.prepare('SELECT c.id,c.name,c.phone,c.loyalty_points,COUNT(o.id) orders FROM customers c LEFT JOIN orders o ON o.customer_id=c.id GROUP BY c.id ORDER BY c.loyalty_points DESC,c.name LIMIT 300').all(),settings:{points_per_1000:db.prepare("SELECT value FROM app_settings WHERE key='loyalty_points_per_1000'").get()?.value||'1'}}));
app.put('/api/admin/loyalty/settings',adminOnly,(req,res)=>{const points=Number(req.body.points_per_1000);if(!Number.isInteger(points)||points<0||points>100)return res.status(400).json({error:'Points per UGX 1,000 must be between 0 and 100.'});db.prepare("INSERT INTO app_settings(key,value) VALUES('loyalty_points_per_1000',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(points));res.json({ok:true});});
app.get('/api/me/loyalty',currentCustomer,(req,res)=>{const c=db.prepare('SELECT loyalty_points FROM customers WHERE id=?').get(req.session.customerId);res.json({points:c?.loyalty_points||0});});
app.get('/api/admin/summary',adminOnly,(req,res)=>{const orders=db.prepare("SELECT COUNT(*) count, COALESCE(SUM(CASE WHEN payment_status='Paid' OR (payment_method='Cash on delivery' AND status='Delivered') THEN total-discount_amount+tax_amount+delivery_fee ELSE 0 END),0) revenue FROM orders WHERE status!='Cancelled'").get();const customers=db.prepare('SELECT COUNT(*) count FROM customers').get();res.json({orders:orders.count,revenue:orders.revenue,customers:customers.count});});
app.get('/api/admin/orders',adminOnly,(req,res)=>{const rows=db.prepare('SELECT o.id,o.items_json,o.total,o.delivery_address,o.notes,o.status,o.created_at,o.scheduled_for,o.customer_lat,o.customer_lng,o.rider_lat,o.rider_lng,o.rider_updated_at,o.rider_id,o.rider_assignment_status,o.payment_method,o.payment_status,o.delivery_fee,o.discount_amount,o.discount_code,o.tax_amount,o.scheduled_for,c.name customer_name,c.phone customer_phone,c.email customer_email,r.name rider_name FROM orders o JOIN customers c ON c.id=o.customer_id LEFT JOIN riders r ON r.id=o.rider_id ORDER BY o.id DESC LIMIT 100').all();res.json({orders:rows.map(o=>({...o,items:JSON.parse(o.items_json)}))});});
// Admin-only live delivery map feed. Coordinates are shared only for active orders.
app.get('/api/admin/live-locations',adminOnly,(req,res)=>{const orders=db.prepare(`SELECT o.id,o.status,o.delivery_address,o.customer_lat,o.customer_lng,o.rider_lat,o.rider_lng,o.rider_updated_at,o.rider_id,c.name customer_name,c.phone customer_phone,r.name rider_name,r.phone rider_phone FROM orders o JOIN customers c ON c.id=o.customer_id LEFT JOIN riders r ON r.id=o.rider_id WHERE o.status NOT IN ('Delivered','Cancelled') ORDER BY o.id DESC`).all();const cfg=Object.fromEntries(db.prepare("SELECT key,value FROM app_settings WHERE key IN ('restaurant_lat','restaurant_lng')").all().map(x=>[x.key,x.value]));res.json({orders,restaurant:{lat:cfg.restaurant_lat===''?null:Number(cfg.restaurant_lat),lng:cfg.restaurant_lng===''?null:Number(cfg.restaurant_lng)},updated_at:new Date().toISOString()});});
app.patch('/api/admin/orders/:id',adminOnly,(req,res)=>{
 const id=Number(req.params.id),status=String(req.body.status||'');
 const order=db.prepare('SELECT id,customer_id,total,loyalty_awarded,status FROM orders WHERE id=?').get(id);
 if(!order)return res.status(404).json({error:'Order not found.'});
 const nextByCurrent={'Received':['Confirmed','Cancelled'],'Confirmed':['Preparing','Cancelled'],'Preparing':['Ready for delivery','Cancelled'],'Ready for delivery':['Cancelled']};
 if(!(nextByCurrent[order.status]||[]).includes(status))return res.status(409).json({error:`Invalid delivery step. An order at “${order.status}” can only move to ${(nextByCurrent[order.status]||[]).join(' or ')||'no further admin-managed status'}. Riders update delivery after collection.`});
 db.transaction(()=>{
  db.prepare('UPDATE orders SET status=? WHERE id=?').run(status,id);
  db.prepare('INSERT INTO order_events(order_id,actor,event,details) VALUES(?,?,?,?)').run(id,'admin',status.toLowerCase().replaceAll(' ','_'),`Order status changed from ${order.status} to ${status}`);
  notify('customer',order.customer_id,'Order update',`Order #${id}: ${status}.`,id);
  if(status==='Confirmed')notify('admin',null,'Order confirmed',`Order #${id} has been confirmed and is waiting for kitchen preparation.`,id);
  if(status==='Preparing')notify('admin',null,'Kitchen preparation started',`The kitchen has started preparing order #${id}.`,id);
  if(status==='Ready for delivery'){
   const rider=db.prepare('SELECT id FROM riders WHERE id=(SELECT rider_id FROM orders WHERE id=?) AND active=1').get(id);
   if(rider)notify('rider',rider.id,'Order ready for collection',`Order #${id} is ready. Please collect it from the kitchen.`,id);
  }
  if(status==='Cancelled')db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run('admin','order_cancel',`Order #${id} cancelled before dispatch`);
 });
 if(status==='Preparing')applyRecipeStockDeduction(id);
 res.json({ok:true,status});
});

app.get('/api/orders/:id/tracking', currentCustomer, (req,res) => {
  // A customer can only retrieve tracking details for their own order.
  const order = db.prepare(`SELECT o.id,o.customer_id,o.items_json,o.total,o.delivery_fee,o.payment_status,
    o.status,o.delivery_address,o.created_at,o.customer_lat,o.customer_lng,o.rider_lat,o.rider_lng,
    o.rider_updated_at,o.rider_id,r.name AS rider_name,r.phone AS rider_phone
    FROM orders o LEFT JOIN riders r ON r.id=o.rider_id
    WHERE o.id=? AND o.customer_id=?`).get(Number(req.params.id),req.customer.id);
  if (!order) return res.status(404).json({error:'Order not found.'});
  const events=db.prepare('SELECT actor,event,details,created_at FROM order_events WHERE order_id=? ORDER BY id ASC').all(order.id);
  res.json({order:{...order,items:JSON.parse(order.items_json),events}});
});
app.post('/api/admin/orders/:id/rider-location', adminOnly, (req,res) => {
  const lat=Number(req.body.lat), lng=Number(req.body.lng);
  if (!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180) return res.status(400).json({error:'Valid rider coordinates are required.'});
  const result=db.prepare("UPDATE orders SET rider_lat=?,rider_lng=?,rider_updated_at=CURRENT_TIMESTAMP WHERE id=? AND status NOT IN ('Delivered','Cancelled')").run(lat,lng,Number(req.params.id));
  if(!result.changes)return res.status(404).json({error:'Active order not found.'});
  res.json({ok:true});
});
app.get('/api/promotions',(req,res)=>res.json({promotions:db.prepare('SELECT id,title,description,discount_percent,image_url,slide_duration_seconds FROM promotions WHERE active=1 ORDER BY id DESC').all()}));
app.get('/api/admin/promotions',adminOnly,(req,res)=>res.json({promotions:db.prepare('SELECT * FROM promotions ORDER BY id DESC').all()}));
app.post('/api/admin/promotions',adminOnly,(req,res)=>{const title=String(req.body.title||'').trim().slice(0,80);const description=String(req.body.description||'').trim().slice(0,240);const discount=Number(req.body.discount_percent||0);const duration=Number(req.body.slide_duration_seconds??5);if(title.length<3||!Number.isInteger(discount)||discount<0||discount>90)return res.status(400).json({error:'Enter a title and a discount between 0 and 90.'});if(!Number.isInteger(duration)||duration<1||duration>60)return res.status(400).json({error:'Slide duration must be between 1 and 60 seconds.'});let imageUrl='';try{imageUrl=saveMenuImage(req.body.imageData);}catch(err){return res.status(400).json({error:err.message});}const result=db.prepare('INSERT INTO promotions(title,description,discount_percent,image_url,slide_duration_seconds) VALUES(?,?,?,?,?)').run(title,description,discount,imageUrl,duration);res.json({ok:true,id:Number(result.lastInsertRowid)});});
app.patch('/api/admin/promotions/:id',adminOnly,(req,res)=>{const active=Number(req.body.active)?1:0;const result=db.prepare('UPDATE promotions SET active=? WHERE id=?').run(active,Number(req.params.id));if(!result.changes)return res.status(404).json({error:'Promotion not found.'});res.json({ok:true});});
app.delete('/api/admin/promotions/:id',adminOnly,(req,res)=>{const result=db.prepare('DELETE FROM promotions WHERE id=?').run(Number(req.params.id));if(!result.changes)return res.status(404).json({error:'Promotion not found.'});res.json({ok:true});});
app.get('/api/me', currentCustomer, (req, res) => res.json({ customer: req.customer }));
app.patch('/api/me', currentCustomer, (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const phone = String(req.body.phone || '').trim();
  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || phone.length < 7) {
    return res.status(400).json({ error: 'Enter your full name, a valid email address, and a phone number of at least 7 characters.' });
  }
  const duplicate = db.prepare('SELECT id FROM customers WHERE email = ? AND id <> ?').get(email, req.customer.id);
  if (duplicate) return res.status(409).json({ error: 'That email address is already used by another account.' });
  db.prepare('UPDATE customers SET name=?, email=?, phone=? WHERE id=?').run(name, email, phone, req.customer.id);
  const customer = db.prepare('SELECT id,name,email,phone FROM customers WHERE id=?').get(req.customer.id);
  req.customer = customer;
  res.json({ customer, message: 'Your account details have been updated.' });
});

app.post('/api/me/change-password',currentCustomer,async(req,res)=>{const current=String(req.body.currentPassword||''),next=String(req.body.newPassword||'');if(next.length<8)return res.status(400).json({error:'New password must contain at least 8 characters.'});const row=db.prepare('SELECT password_hash FROM customers WHERE id=?').get(req.customer.id);if(!row||!(await bcrypt.compare(current,row.password_hash)))return res.status(401).json({error:'Current password is incorrect.'});const hash=await bcrypt.hash(next,12);db.prepare('UPDATE customers SET password_hash=? WHERE id=?').run(hash,req.customer.id);res.json({ok:true,message:'Password changed successfully.'});});
app.get('/api/me/addresses',currentCustomer,(req,res)=>res.json({addresses:db.prepare('SELECT id,label,address,created_at FROM customer_addresses WHERE customer_id=? ORDER BY id DESC').all(req.customer.id)}));
app.post('/api/me/addresses',currentCustomer,(req,res)=>{const label=String(req.body.label||'Home').trim().slice(0,40),address=String(req.body.address||'').trim().slice(0,300);if(address.length<5)return res.status(400).json({error:'Enter a complete delivery address.'});const count=db.prepare('SELECT COUNT(*) count FROM customer_addresses WHERE customer_id=?').get(req.customer.id).count;if(count>=10)return res.status(400).json({error:'You can save up to 10 delivery addresses.'});const r=db.prepare('INSERT INTO customer_addresses(customer_id,label,address) VALUES(?,?,?)').run(req.customer.id,label||'Home',address);res.json({ok:true,id:Number(r.lastInsertRowid)});});
app.delete('/api/me/addresses/:id',currentCustomer,(req,res)=>{const r=db.prepare('DELETE FROM customer_addresses WHERE id=? AND customer_id=?').run(Number(req.params.id),req.customer.id);if(!r.changes)return res.status(404).json({error:'Saved address not found.'});res.json({ok:true});});

app.post('/api/orders', currentCustomer, async (req, res) => {
  const items = req.body.items;
  const address = String(req.body.address || '').trim();
  const notes = String(req.body.notes || '').trim().slice(0, 500);
  const scheduledForRaw = String(req.body.scheduled_for || '').trim();
  const parseCoordinate = (value, min, max) => {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= min && number <= max ? number : NaN;
  };
  const customerLat = parseCoordinate(req.body.customer_lat, -90, 90);
  const customerLng = parseCoordinate(req.body.customer_lng, -180, 180);
  if (Number.isNaN(customerLat) || Number.isNaN(customerLng) || ((customerLat === null) !== (customerLng === null))) {
    return res.status(400).json({ error: 'Enter both valid GPS coordinates, or leave both blank and provide a delivery address.' });
  }
  if (!Array.isArray(items) || items.length === 0 || !address) return res.status(400).json({ error: 'Add food to your cart and enter a delivery address.' });
  const cleanItems = [];
  let total = 0;
  for (const item of items) {
    const id = Number(item.id), qty = Number(item.qty);
    const product = db.prepare('SELECT id,name,price FROM menu_items WHERE id=? AND active=1').get(id);
    if (!product || !Number.isInteger(qty) || qty < 1 || qty > 50) return res.status(400).json({ error: 'Your cart contains an invalid item.' });
    cleanItems.push({ id: product.id, name: product.name, price: product.price, qty });
    total += product.price * qty;
  }
  const settingsRows=db.prepare('SELECT key,value FROM app_settings').all(); const settings=Object.fromEntries(settingsRows.map(x=>[x.key,x.value]));
  let scheduledFor = null;
  if (scheduledForRaw) {
    if (settings.scheduled_orders_enabled === 'false') return res.status(400).json({error:'Scheduled orders are currently disabled by the kitchen.'});
    const parsedSchedule = Date.parse(scheduledForRaw);
    const now = Date.now();
    if (!Number.isFinite(parsedSchedule) || parsedSchedule < now + 30*60*1000 || parsedSchedule > now + 30*24*60*60*1000) return res.status(400).json({error:'Choose a delivery time at least 30 minutes from now and within the next 30 days.'});
    scheduledFor = new Date(parsedSchedule).toISOString();
  }
  const minimumOrder=Number(settings.minimum_order_amount||0);
  if(total<minimumOrder) return res.status(400).json({error:`The minimum food order is UGX ${minimumOrder.toLocaleString('en-UG')}.`});
  const dailyLimit=Number(settings.max_daily_orders||0);
  if(dailyLimit>0){const count=db.prepare("SELECT COUNT(*) count FROM orders WHERE date(created_at)=date('now','localtime') AND status!='Cancelled'").get().count;if(count>=dailyLimit)return res.status(429).json({error:'The kitchen has reached its order limit for today. Please try again tomorrow.'});}
  const discountCode=String(req.body.discount_code||'').trim().toUpperCase().replace(/[^A-Z0-9_-]/g,'').slice(0,30);
  let discountPercent=0,discountAmount=0;
  if(discountCode){
    const code=db.prepare("SELECT * FROM discount_codes WHERE code=? AND active=1 AND (starts_at IS NULL OR date(starts_at)<=date('now')) AND (ends_at IS NULL OR date(ends_at)>=date('now')) AND (max_uses=0 OR uses<max_uses)").get(discountCode);
    if(!code)return res.status(400).json({error:'This discount code is invalid, expired, paused or has reached its usage limit.'});
    discountPercent=Number(code.discount_percent)||0;discountAmount=Math.round(total*discountPercent/100);
  }
  const taxPercent=Math.max(0,Math.min(30,Number(settings.tax_percent||0)));
  const taxAmount=Math.round((total-discountAmount)*taxPercent/100);
  if(customerLat!==null&&customerLng!==null&&settings.restaurant_lat!==undefined&&settings.restaurant_lng!==undefined&&settings.restaurant_lat!==''&&settings.restaurant_lng!==''){
    const rad=x=>x*Math.PI/180,lat1=Number(settings.restaurant_lat),lon1=Number(settings.restaurant_lng),lat2=customerLat,lon2=customerLng;
    const a=Math.sin(rad(lat2-lat1)/2)**2+Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(rad(lon2-lon1)/2)**2;
    const distanceKm=6371*2*Math.asin(Math.sqrt(a));
    const maxDistance=Number(settings.max_delivery_km||settings.delivery_radius_km||0);
    if(maxDistance>0&&distanceKm>maxDistance)return res.status(400).json({error:`Your delivery location is ${distanceKm.toFixed(1)} km away, beyond our ${maxDistance} km delivery limit. Please choose pickup or contact the kitchen.`});
  }
  const method=String(req.body.payment_method||'Cash on delivery');
  const allowedMethods=['Cash on delivery','MTN Mobile Money','Airtel Money','Bank transfer','Visa/Mastercard'];
  if(!allowedMethods.includes(method)) return res.status(400).json({error:'Choose a supported payment method.'});
  const gatewayMethod = method==='MTN Mobile Money' || method==='Airtel Money' || method==='Visa/Mastercard';
  if(gatewayMethod && (!FLW_SECRET_KEY || !APP_BASE_URL || !/^https:\/\//i.test(APP_BASE_URL))) return res.status(503).json({error:'Online payment is not configured yet. Please choose Cash on delivery or contact the kitchen.'});
  let zoneFee=Number(settings.delivery_fee||0);
  const matchedZone=db.prepare('SELECT fee FROM delivery_zones WHERE active=1 AND instr(lower(?),lower(name))>0 ORDER BY length(name) DESC LIMIT 1').get(address);
  if(matchedZone)zoneFee=Number(matchedZone.fee||0);
  const deliveryFee=total>=Number(settings.free_delivery_minimum||0)&&Number(settings.free_delivery_minimum||0)>0?0:zoneFee;
  const initialStatus=settings.auto_confirm_orders==='true'?'Confirmed':'Received';
  const grandTotal=total-discountAmount+taxAmount+deliveryFee;
  let txRef='';
  const createOrder = db.transaction(() => {
    const result = db.prepare('INSERT INTO orders (customer_id,items_json,total,delivery_address,notes,customer_lat,customer_lng,payment_method,payment_status,delivery_fee,status,discount_amount,discount_code,tax_amount,scheduled_for) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(req.customer.id, JSON.stringify(cleanItems), total, address, notes, customerLat, customerLng, method, 'Pending', deliveryFee, initialStatus,discountAmount,discountCode,taxAmount,scheduledFor);
    const newOrderId=Number(result.lastInsertRowid);
    db.prepare('INSERT INTO order_events(order_id,actor,event,details) VALUES(?,?,?,?)').run(newOrderId,'customer','received','Customer placed the order.');
    if(initialStatus==='Confirmed')db.prepare('INSERT INTO order_events(order_id,actor,event,details) VALUES(?,?,?,?)').run(newOrderId,'system','confirmed','Order was automatically confirmed by the business setting.');
    txRef=`EDDYS-${newOrderId}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    db.prepare('INSERT INTO payments(order_id,customer_id,method,amount,status,tx_ref) VALUES(?,?,?,?,?,?)').run(newOrderId,req.customer.id,method,grandTotal,'Pending',gatewayMethod?txRef:'');
    if(discountCode)db.prepare('UPDATE discount_codes SET uses=uses+1 WHERE code=?').run(discountCode);
    notify('admin',null,'New order received',`Order #${newOrderId} from ${req.customer.name}; total UGX ${grandTotal.toLocaleString('en-UG')}.`,newOrderId);
    notify('customer',req.customer.id,'Order received',`Your order #${newOrderId} has been received${scheduledFor?` for ${scheduledFor}`:''}. Payment status: Pending.`,newOrderId);
    return newOrderId;
  });
  const orderId=createOrder();
  if (gatewayMethod) {
    try {
      const paymentOptions = method==='Visa/Mastercard' ? 'card' : 'mobilemoneyuganda';
      const gatewayResponse = await fetch('https://api.flutterwave.com/v3/payments', {
        method:'POST', headers:{Authorization:`Bearer ${FLW_SECRET_KEY}`,'Content-Type':'application/json',Accept:'application/json'},
        body:JSON.stringify({tx_ref:txRef,amount:grandTotal,currency:'UGX',redirect_url:`${APP_BASE_URL}/payment-callback`,payment_options:paymentOptions,customer:{email:req.customer.email,name:req.customer.name,phonenumber:req.customer.phone},customizations:{title:'Eddys Kitchen',description:`Payment for order #${orderId}`},meta:{order_id:orderId}})
      });
      const gatewayData=await gatewayResponse.json();
      if (!gatewayResponse.ok || gatewayData.status!=='success' || !gatewayData.data?.link) throw new Error(gatewayData.message||'Could not create hosted payment session.');
      return res.json({orderId,total,deliveryFee,grandTotal,paymentMethod:method,paymentStatus:'Pending',paymentUrl:gatewayData.data.link});
    } catch(error) {
      console.error('Flutterwave checkout creation failed:',error.message);
      db.transaction(()=>{db.prepare("UPDATE payments SET status='Failed',updated_at=CURRENT_TIMESTAMP WHERE tx_ref=?").run(txRef);db.prepare("UPDATE orders SET status='Cancelled' WHERE id=? AND payment_status='Pending'").run(orderId);if(discountCode)db.prepare('UPDATE discount_codes SET uses=CASE WHEN uses>0 THEN uses-1 ELSE 0 END WHERE code=?').run(discountCode);});
      return res.status(502).json({error:'The payment provider could not start checkout. No payment was taken. Please try again.'});
    }
  }
  res.json({ orderId, total, discountAmount, discountCode, taxAmount, deliveryFee, grandTotal, paymentMethod:method, paymentStatus:'Pending' });
});

app.get('/api/orders', currentCustomer, (req, res) => {
  // Include the assigned rider so the customer can distinguish an unassigned
  // order from one whose rider has not started sharing GPS yet.
  const orders = db.prepare(`SELECT o.id,o.items_json,o.total,o.delivery_address,o.notes,o.status,o.created_at,
    o.customer_lat,o.customer_lng,o.rider_lat,o.rider_lng,o.rider_updated_at,o.rider_id,o.payment_method,o.payment_status,o.delivery_fee,o.discount_amount,o.discount_code,o.tax_amount,o.scheduled_for,
    r.name AS rider_name,r.phone AS rider_phone
    FROM orders o LEFT JOIN riders r ON r.id=o.rider_id
    WHERE o.customer_id = ? ORDER BY o.id DESC`).all(req.customer.id);
  res.json({ orders: orders.map(o => ({ ...o, items: JSON.parse(o.items_json), events: db.prepare('SELECT actor,event,details,created_at FROM order_events WHERE order_id=? ORDER BY id ASC').all(o.id) })) });
});

const DEFAULT_MENU = [
 {id:1,name:'Chicken & Chips',category:'Main Meals',cuisine:'Uganda',price:18000,description:'Crispy chips served with tasty chicken.',emoji:'🍗'},
 {id:2,name:'Beef Pilau',category:'Main Meals',cuisine:'Uganda',price:15000,description:'Spiced rice cooked with tender beef.',emoji:'🍛'},
 {id:3,name:'Grilled Chicken',category:'Main Meals',cuisine:'Uganda',price:22000,description:'Juicy grilled chicken with seasoning.',emoji:'🍗'},
 {id:4,name:'Fish & Chips',category:'Main Meals',cuisine:'United Kingdom',price:20000,description:'Golden fish with crispy chips.',emoji:'🐟'},
 {id:5,name:'Vegetable Rice',category:'Vegetarian',cuisine:'China',price:12000,description:'Rice tossed with colourful vegetables.',emoji:'🥗'},
 {id:6,name:'Beans & Posho',category:'Vegetarian',cuisine:'Uganda',price:8000,description:'A comforting local favourite.',emoji:'🍲'},
 {id:7,name:'Rolex',category:'Quick Bites',cuisine:'Uganda',price:5000,description:'Eggs and vegetables wrapped in chapati.',emoji:'🌯'},
 {id:8,name:'Samosas (2)',category:'Quick Bites',cuisine:'India',price:4000,description:'Crispy pastry with savoury filling.',emoji:'🥟'},
 {id:9,name:'Chapati',category:'Quick Bites',cuisine:'India',price:2000,description:'Soft, freshly made flatbread.',emoji:'🫓'},
 {id:10,name:'Fresh Passion Juice',category:'Drinks',cuisine:'Uganda',price:5000,description:'Cool, refreshing passion fruit juice.',emoji:'🧃'},
 {id:11,name:'Soda',category:'Drinks',cuisine:'International',price:3000,description:'A chilled fizzy drink.',emoji:'🥤'},
 {id:12,name:'Bottled Water',category:'Drinks',cuisine:'International',price:2000,description:'Stay refreshed.',emoji:'💧'},
 {id:13,name:'Chocolate Cake',category:'Desserts',cuisine:'France',price:7000,description:'A rich slice of chocolate cake.',emoji:'🍰'},
 {id:14,name:'Fruit Salad',category:'Desserts',cuisine:'International',price:6000,description:'A fresh mix of seasonal fruits.',emoji:'🍓'},
 {id:15,name:'Chicken Biryani',category:'Main Meals',cuisine:'India',price:19000,description:'Fragrant rice with spiced chicken.',emoji:'🍛'},
 {id:16,name:'Margherita Pizza',category:'Quick Bites',cuisine:'Italy',price:25000,description:'Tomato, cheese and basil on a baked base.',emoji:'🍕'},
 {id:17,name:'Spaghetti Bolognese',category:'Main Meals',cuisine:'Italy',price:22000,description:'Pasta with a rich tomato and beef sauce.',emoji:'🍝'},
 {id:18,name:'Sushi Roll',category:'Quick Bites',cuisine:'Japan',price:28000,description:'Japanese-style rice rolls.',emoji:'🍣'},
 {id:19,name:'Fried Rice',category:'Main Meals',cuisine:'China',price:16000,description:'Wok-style rice with vegetables and egg.',emoji:'🍚'},
 {id:20,name:'Jollof Rice',category:'Main Meals',cuisine:'Nigeria',price:17000,description:'Tomato-seasoned West African rice.',emoji:'🍚'},
 {id:21,name:'Tacos',category:'Quick Bites',cuisine:'Mexico',price:18000,description:'Tortillas filled with seasoned savoury ingredients.',emoji:'🌮'},
 {id:22,name:'Falafel Wrap',category:'Vegetarian',cuisine:'Middle East',price:14000,description:'Chickpea falafel with fresh vegetables.',emoji:'🥙'},
 {id:23,name:'Doro Wat',category:'Main Meals',cuisine:'Ethiopia',price:24000,description:'Ethiopian-style spiced chicken stew.',emoji:'🍲'},
 {id:24,name:'Pancakes',category:'Breakfast',cuisine:'United States',price:10000,description:'Soft pancakes served for breakfast.',emoji:'🥞'}
];
// Seed the editable menu once, then keep menu items in SQLite so the admin can manage them.
const menuCount = db.prepare('SELECT COUNT(*) count FROM menu_items').get().count;
if (!menuCount) {
  const insertMenu = db.prepare('INSERT INTO menu_items (id,name,category,cuisine,price,description,emoji,active) VALUES (@id,@name,@category,@cuisine,@price,@description,@emoji,1)');
  const seedMenu = db.transaction(items => items.forEach(item => insertMenu.run(item)));
  seedMenu(DEFAULT_MENU);
}
const MENU = () => db.prepare('SELECT id,name,category,cuisine,price,description,emoji,image_url FROM menu_items WHERE active=1 ORDER BY id').all();
app.get('/api/menu', (req, res) => res.json({ menu: MENU() }));
app.get('/api/admin/menu', adminOnly, (req,res) => res.json({menu:db.prepare('SELECT * FROM menu_items ORDER BY id DESC').all()}));
function saveMenuImage(imageData) {
  if (!imageData) return '';
  if (typeof imageData !== 'string' || imageData.length > 5 * 1024 * 1024 * 1.4) throw new Error('Image is too large. Choose an image smaller than 5 MB.');
  const match = imageData.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error('Choose a JPG, PNG, WEBP, or GIF image.');
  const ext = ({'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif'})[match[1]];
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new Error('Image must be 5 MB or smaller.');
  const filename = `food-${Date.now()}-${require('crypto').randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(uploadsDir, filename), bytes, { flag: 'wx' });
  return '/uploads/' + filename;
}
app.post('/api/admin/menu', adminOnly, (req,res) => {
  const name=String(req.body.name||'').trim().slice(0,80), category=String(req.body.category||'').trim().slice(0,40), cuisine=String(req.body.cuisine||'International').trim().slice(0,50), description=String(req.body.description||'').trim().slice(0,240), emoji=String(req.body.emoji||'🍽️').slice(0,12), price=Number(req.body.price);
  if(name.length<2||category.length<2||!Number.isInteger(price)||price<500||price>10000000)return res.status(400).json({error:'Enter a meal name, category and valid price in UGX.'});
  let imageUrl = '';
  try { imageUrl = saveMenuImage(req.body.imageData); } catch (err) { return res.status(400).json({error:err.message}); }
  const result=db.prepare('INSERT INTO menu_items(name,category,cuisine,price,description,emoji,image_url) VALUES(?,?,?,?,?,?,?)').run(name,category,cuisine,price,description,emoji,imageUrl);
  res.json({ok:true,id:Number(result.lastInsertRowid)});
});
app.delete('/api/admin/menu/:id', adminOnly, (req,res) => { const id=Number(req.params.id); const item=db.prepare('SELECT id FROM menu_items WHERE id=?').get(id); if(!item)return res.status(404).json({error:'Menu item not found.'}); db.prepare('UPDATE menu_items SET active=0 WHERE id=?').run(id); res.json({ok:true,message:'Food item removed from the active menu; historical orders are preserved.'}); });
app.patch('/api/admin/menu/:id', adminOnly, (req,res) => {
  const id=Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({error:'Invalid menu item.'});
  const existing=db.prepare('SELECT id FROM menu_items WHERE id=?').get(id);
  if(!existing)return res.status(404).json({error:'Menu item not found.'});
  if (Object.prototype.hasOwnProperty.call(req.body,'active')) {
    const active=Number(req.body.active)?1:0;
    db.prepare('UPDATE menu_items SET active=? WHERE id=?').run(active,id);
  }
  const fields=['name','category','cuisine','price','description','emoji'];
  const updates=[], values=[];
  for (const field of fields) if (Object.prototype.hasOwnProperty.call(req.body,field)) {
    let value=req.body[field];
    if (field==='price') { value=Number(value); if(!Number.isInteger(value)||value<500||value>10000000)return res.status(400).json({error:'Enter a valid price in UGX.'}); }
    else { value=String(value ?? '').trim(); const max=field==='description'?240:field==='name'?80:field==='category'?40:field==='cuisine'?50:12; value=value.slice(0,max); }
    if ((field==='name'||field==='category') && value.length<2)return res.status(400).json({error:'Name and category must contain at least 2 characters.'});
    updates.push(`${field}=?`); values.push(value);
  }
  if(req.body.imageData) {
    try { updates.push('image_url=?'); values.push(saveMenuImage(req.body.imageData)); }
    catch(err) { return res.status(400).json({error:err.message}); }
  }
  if(updates.length)db.prepare(`UPDATE menu_items SET ${updates.join(',')} WHERE id=?`).run(...values,id);
  res.json({ok:true});
});


// Extended admin operations: delivery zones, discounts, expiry, stocktake, payroll, leave, support and analytics.
app.get('/api/admin/operations',adminOnly,(req,res)=>{
 const expiry=db.prepare("SELECT b.*,i.name item_name,i.unit FROM stock_batches b JOIN inventory_items i ON i.id=b.item_id ORDER BY CASE WHEN b.expiry_date IS NULL THEN 1 ELSE 0 END,b.expiry_date LIMIT 200").all();
 const payroll=db.prepare('SELECT p.*,s.name staff_name FROM staff_payroll p JOIN staff_records s ON s.id=p.staff_record_id ORDER BY p.id DESC LIMIT 100').all();
 const leave=db.prepare('SELECT l.*,s.name staff_name FROM staff_leave l JOIN staff_records s ON s.id=l.staff_record_id ORDER BY l.id DESC LIMIT 100').all();
 const tickets=db.prepare('SELECT t.*,c.name customer_name FROM support_tickets t LEFT JOIN customers c ON c.id=t.customer_id ORDER BY t.id DESC LIMIT 100').all();
 res.json({zones:db.prepare('SELECT * FROM delivery_zones ORDER BY name').all(),discounts:db.prepare('SELECT * FROM discount_codes ORDER BY id DESC').all(),expiry,payroll,leave,tickets,security:db.prepare('SELECT * FROM security_events ORDER BY id DESC LIMIT 50').all(),stocktakes:db.prepare('SELECT st.*,i.name item_name,i.unit FROM stocktakes st JOIN inventory_items i ON i.id=st.item_id ORDER BY st.id DESC LIMIT 50').all()});
});
app.post('/api/admin/delivery-zones',adminOnly,(req,res)=>{const name=String(req.body.name||'').trim().slice(0,80),fee=Number(req.body.fee);if(!name||!Number.isSafeInteger(fee)||fee<0)return res.status(400).json({error:'Enter a delivery area and a valid non-negative fee.'});try{db.prepare('INSERT INTO delivery_zones(name,fee) VALUES(?,?)').run(name,fee);}catch(e){return res.status(409).json({error:'That delivery zone already exists.'});}res.json({ok:true});});
app.patch('/api/admin/delivery-zones/:id',adminOnly,(req,res)=>{const active=req.body.active?1:0;const r=db.prepare('UPDATE delivery_zones SET active=? WHERE id=?').run(active,Number(req.params.id));if(!r.changes)return res.status(404).json({error:'Zone not found.'});res.json({ok:true});});
app.post('/api/admin/discount-codes',adminOnly,(req,res)=>{const code=String(req.body.code||'').trim().toUpperCase().replace(/[^A-Z0-9_-]/g,'').slice(0,30),pct=Number(req.body.discount_percent),max=Number(req.body.max_uses||0);if(code.length<3||!Number.isInteger(pct)||pct<1||pct>80||!Number.isInteger(max)||max<0)return res.status(400).json({error:'Use a code of at least 3 characters, discount 1–80%, and a non-negative usage limit.'});try{db.prepare('INSERT INTO discount_codes(code,discount_percent,starts_at,ends_at,max_uses) VALUES(?,?,?,?,?)').run(code,pct,req.body.starts_at||null,req.body.ends_at||null,max);}catch(e){return res.status(409).json({error:'That discount code already exists.'});}res.json({ok:true});});
app.patch('/api/admin/discount-codes/:id',adminOnly,(req,res)=>{const r=db.prepare('UPDATE discount_codes SET active=? WHERE id=?').run(req.body.active?1:0,Number(req.params.id));if(!r.changes)return res.status(404).json({error:'Discount code not found.'});res.json({ok:true});});
app.post('/api/admin/stock-batches',adminOnly,(req,res)=>{const item=Number(req.body.item_id),qty=Number(req.body.quantity),date=String(req.body.expiry_date||'');if(!db.prepare('SELECT id FROM inventory_items WHERE id=?').get(item)||!Number.isFinite(qty)||qty<=0||(date&&!/^\d{4}-\d{2}-\d{2}$/.test(date)))return res.status(400).json({error:'Choose an item and valid quantity/expiry date.'});db.prepare('INSERT INTO stock_batches(item_id,quantity,expiry_date,notes) VALUES(?,?,?,?)').run(item,qty,date||null,String(req.body.notes||'').slice(0,250));res.json({ok:true});});
app.post('/api/admin/stocktakes',adminOnly,(req,res)=>{const id=Number(req.body.item_id),count=Number(req.body.counted_quantity),item=db.prepare('SELECT * FROM inventory_items WHERE id=?').get(id);if(!item||!Number.isFinite(count)||count<0)return res.status(400).json({error:'Choose an item and enter a valid counted quantity.'});const diff=count-Number(item.quantity);db.transaction(()=>{db.prepare('INSERT INTO stocktakes(item_id,system_quantity,counted_quantity,difference,notes) VALUES(?,?,?,?,?)').run(id,item.quantity,count,diff,String(req.body.notes||'').slice(0,250));db.prepare('UPDATE inventory_items SET quantity=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(count,id);db.prepare('INSERT INTO audit_logs(actor,action,details) VALUES(?,?,?)').run('admin','stocktake',`Stocktake ${item.name}: ${item.quantity} → ${count}`);})();res.json({ok:true,difference:diff});});
app.post('/api/admin/payroll',adminOnly,(req,res)=>{const sid=Number(req.body.staff_record_id),period=String(req.body.pay_period||'').slice(0,20),amount=Number(req.body.amount);if(!db.prepare('SELECT id FROM staff_records WHERE id=?').get(sid)||!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)||!Number.isSafeInteger(amount)||amount<0)return res.status(400).json({error:'Choose staff, a YYYY-MM pay period and valid amount.'});db.prepare('INSERT INTO staff_payroll(staff_record_id,pay_period,amount,notes) VALUES(?,?,?,?)').run(sid,period,amount,String(req.body.notes||'').slice(0,250));res.json({ok:true});});
app.patch('/api/admin/payroll/:id',adminOnly,(req,res)=>{const status=String(req.body.status||'');if(!['Unpaid','Paid','On hold'].includes(status))return res.status(400).json({error:'Invalid payroll status.'});const r=db.prepare('UPDATE staff_payroll SET status=?,paid_at=CASE WHEN ?=\'Paid\' THEN CURRENT_TIMESTAMP ELSE paid_at END WHERE id=?').run(status,status,Number(req.params.id));if(!r.changes)return res.status(404).json({error:'Payroll record not found.'});res.json({ok:true});});
app.post('/api/admin/staff-leave',adminOnly,(req,res)=>{const sid=Number(req.body.staff_record_id),start=String(req.body.start_date||''),end=String(req.body.end_date||''),reason=String(req.body.reason||'').trim().slice(0,250);if(!db.prepare('SELECT id FROM staff_records WHERE id=?').get(sid)||!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||end<start||!reason)return res.status(400).json({error:'Enter valid staff, dates and reason.'});db.prepare('INSERT INTO staff_leave(staff_record_id,start_date,end_date,reason) VALUES(?,?,?,?)').run(sid,start,end,reason);res.json({ok:true});});
app.patch('/api/admin/staff-leave/:id',adminOnly,(req,res)=>{const status=String(req.body.status||'');if(!['Approved','Rejected','Pending'].includes(status))return res.status(400).json({error:'Invalid leave status.'});const r=db.prepare('UPDATE staff_leave SET status=? WHERE id=?').run(status,Number(req.params.id));if(!r.changes)return res.status(404).json({error:'Leave request not found.'});res.json({ok:true});});
app.patch('/api/admin/support/:id',adminOnly,(req,res)=>{const status=String(req.body.status||'Open'),reply=String(req.body.admin_reply||'').slice(0,1000);if(!['Open','In progress','Resolved','Closed'].includes(status))return res.status(400).json({error:'Invalid support status.'});const r=db.prepare('UPDATE support_tickets SET status=?,admin_reply=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status,reply,Number(req.params.id));if(!r.changes)return res.status(404).json({error:'Support ticket not found.'});res.json({ok:true});});
app.get('/api/admin/analytics',adminOnly,(req,res)=>{const daily=db.prepare("SELECT date(created_at) day,COUNT(*) orders,COALESCE(SUM(CASE WHEN payment_status='Paid' OR (payment_method='Cash on delivery' AND status='Delivered') THEN total-discount_amount+tax_amount+delivery_fee ELSE 0 END),0) revenue FROM orders WHERE status!='Cancelled' AND date(created_at)>=date('now','-29 days') GROUP BY date(created_at) ORDER BY day").all();const best=db.prepare("SELECT m.name,COUNT(*) line_count FROM orders o,json_each(o.items_json) j JOIN menu_items m ON m.id=CAST(json_extract(j.value,'$.id') AS INTEGER) WHERE o.status!='Cancelled' GROUP BY m.id ORDER BY line_count DESC LIMIT 10").all();const statuses=db.prepare('SELECT status,COUNT(*) count FROM orders GROUP BY status').all();const expenses=db.prepare("SELECT COALESCE(SUM(amount),0) total FROM expenses WHERE date(expense_date)>=date('now','-29 days')").get().total;const revenue=daily.reduce((a,x)=>a+Number(x.revenue||0),0);res.json({daily,best,statuses,expenses,revenue,estimated_profit:revenue-Number(expenses)});});
app.get('/api/admin/payment-readiness',adminOnly,(req,res)=>res.json({flutterwave:{configured:Boolean(process.env.FLW_SECRET_KEY),webhookConfigured:Boolean(FLW_WEBHOOK_SECRET_HASH)},mtn:{configured:Boolean(process.env.MTN_MOMO_SUBSCRIPTION_KEY&&process.env.MTN_MOMO_API_USER&&process.env.MTN_MOMO_API_KEY),note:'Requires merchant credentials and provider approval.'},airtel:{configured:Boolean(process.env.AIRTEL_CLIENT_ID&&process.env.AIRTEL_CLIENT_SECRET),note:'Requires merchant credentials and provider approval.'},refunds:{automatic:Boolean(process.env.FLW_SECRET_KEY),note:'Approved refunds for verified Flutterwave transactions can be submitted to the provider; final settlement must be checked in the Flutterwave dashboard.'}}));

app.use('/api', (req, res) => res.status(404).json({ error: `API endpoint not found: ${req.method} ${req.path}` }));
app.use((err, req, res, next) => {
  console.error('Unhandled request error:', err && (err.stack || err.message || err));
  if (res.headersSent) return next(err);
  if (req.path.startsWith('/api/') && (err instanceof SyntaxError || err.status === 400 || err.type === 'entity.parse.failed')) return res.status(400).json({ error: 'The request body is not valid JSON. Please try again.' });
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'The server could not complete this request. Check the Eddys Kitchen command window for the error details.' });
  res.status(500).send('Eddys Kitchen encountered a server error. Check the server command window.');
});
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html')));

function listenWithPortFallback(port, attempts = 0) {
  const server = app.listen(port, '0.0.0.0', () => {
    if (process.env.EDDYS_PORT_FILE) {
      try { fs.writeFileSync(process.env.EDDYS_PORT_FILE, String(server.address().port), 'utf8'); }
      catch (e) { console.error('Could not write selected port file:', e.message); }
    }
    console.log(`Eddys Kitchen [${BUILD_ID}] is listening on port ${server.address().port}`);
  });
  server.once('error', error => {
    // Local development may have another Eddys Kitchen copy still running.
    // Try the next port automatically instead of leaving the launcher stuck.
    if (error && error.code === 'EADDRINUSE' && process.env.NODE_ENV !== 'production' && attempts < 50) {
      const nextPort = Number(port) + 1;
      console.warn(`Port ${port} is already in use; trying port ${nextPort}...`);
      listenWithPortFallback(nextPort, attempts + 1);
      return;
    }
    console.error(error && error.code === 'EADDRINUSE'
      ? `Port ${port} is already in use. Stop the other service or choose another port.`
      : 'Eddys Kitchen server failed to listen:', error);
    process.exitCode = 1;
  });
  return server;
}

listenWithPortFallback(Number.isInteger(PORT) && PORT >= 0 && PORT <= 65535 ? PORT : 3000);

}
boot().catch(error => { console.error('Eddys Kitchen could not start:', error); process.exit(1); });
