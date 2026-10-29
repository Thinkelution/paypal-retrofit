import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DB_PATH = process.env.FERNHILL_DB ?? path.resolve(here, '..', 'fernhill.db');

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  addr1 TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  country TEXT DEFAULT 'US',
  created_on TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  unit_price REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  issued_on TEXT NOT NULL,
  due_on TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','sent','overdue','paid','void')),
  total REAL NOT NULL,
  notes TEXT,
  paypal_invoice_id TEXT,
  paypal_link TEXT,
  paid_at TEXT,
  paid_amount REAL
);
CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  service_id INTEGER REFERENCES services(id),
  description TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS retainers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  title TEXT NOT NULL,
  monthly_fee REAL NOT NULL,
  start_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','active','cancelled')),
  paypal_subscription_id TEXT
);
`;

export function openDb(file = DEFAULT_DB_PATH): Database.Database {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
