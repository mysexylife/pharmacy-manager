import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  pw_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 제약회사 -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  car_numbers TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

-- 금액(amount)은 항상 양수로 두고, 잔고 계산은 kind로 한다.
--   purchase(입고) +, adjust(조정) +/- (부호 있음), return(반품) -, payment(결제) -
-- deleted_at이 있으면 휴지통에 있는 것이다.
CREATE TABLE IF NOT EXISTS vendor_entries (
  id INTEGER PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('purchase', 'payment', 'return', 'adjust')),
  description TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL,
  return_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ventries ON vendor_entries (vendor_id, date, id);

-- 반품 칸. 처리 완료를 체크하면 vendor_entries에 반품 한 줄이 들어간다.
CREATE TABLE IF NOT EXISTS vendor_returns (
  id INTEGER PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  date TEXT NOT NULL,
  item TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  done_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS vendor_loans (
  id INTEGER PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  date TEXT NOT NULL,
  item TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  returned INTEGER NOT NULL DEFAULT 0,
  returned_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS vendor_notes (
  id INTEGER PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  body TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  done_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

-- 병원 ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hospitals (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS hospital_products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  price INTEGER NOT NULL
);

-- 잔고 = 누적(billed - paid). rx(처방조제약)는 original - discount = billed.
-- otc(일반의약품)는 입력 당시의 금액을 그대로 저장한다 (단가표를 바꿔도 과거 내역은 그대로).
CREATE TABLE IF NOT EXISTS hospital_entries (
  id INTEGER PRIMARY KEY,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id),
  date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('rx', 'otc', 'payment', 'adjust')),
  item TEXT NOT NULL DEFAULT '',
  qty INTEGER,
  original INTEGER,
  discount INTEGER,
  billed INTEGER NOT NULL DEFAULT 0,
  paid INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_hentries ON hospital_entries (hospital_id, date, id);

-- 환자 외상 ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credits (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  name TEXT NOT NULL,
  rrn_front TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL,
  memo_done INTEGER NOT NULL DEFAULT 0,
  paid INTEGER NOT NULL DEFAULT 0,
  paid_date TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export const DEFAULT_SETTINGS = { overdue_days: 30, rx_discount: 5000 };

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? Number(row.value) : DEFAULT_SETTINGS[key];
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

export function audit(db, action, detail = '') {
  db.prepare('INSERT INTO audit_log (action, detail) VALUES (?, ?)').run(action, detail);
}
