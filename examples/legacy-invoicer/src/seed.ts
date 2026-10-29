/**
 * Seeds the Fernhill Studio database with fictional customers, services, invoices and retainers.
 * Deterministic: the same seed always produces the same data, relative to "today".
 *
 *   pnpm fernhill:seed                 # writes examples/legacy-invoicer/fernhill.db
 *   pnpm fernhill:seed -- --buyer you@example.com   # route 3 invoices to your PayPal sandbox buyer
 */
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import { DEFAULT_DB_PATH, openDb } from './db.ts';

export interface SeedOptions {
  file?: string;
  buyerEmail?: string;
  today?: Date;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const CUSTOMERS: Array<[string, string, string, string, string, string]> = [
  ['Maya Okafor', 'maya.okafor@example.com', '12 Birch Lane', 'Portland', 'OR', '97201'],
  ['Daniel Reyes', 'd.reyes@example.com', '440 Harbor St', 'Seattle', 'WA', '98101'],
  ['Priya Natarajan', 'priya.n@example.com', '9 Elm Court', 'Austin', 'TX', '73301'],
  ['Tom Whitaker', 'tom@whitaker-weddings.example.com', '77 Mill Rd', 'Boise', 'ID', '83702'],
  ['Lena Fischer', 'lena.fischer@example.com', '3 Orchard Way', 'Denver', 'CO', '80202'],
  ['Kofi Mensah', 'kofi.mensah@example.com', '58 Pine Ave', 'Sacramento', 'CA', '94203'],
  ['Hana Sato', 'hana.sato@example.com', '201 Cedar Blvd', 'San Jose', 'CA', '95101'],
  ['Oliver Grant', 'ogrant@grant-realty.example.com', '15 Market Sq', 'Spokane', 'WA', '99201'],
  ['Sofia Marino', 'sofia.marino@example.com', '6 Vine St', 'Eugene', 'OR', '97401'],
  ['Ravi Kapoor', 'ravi@kapoor-events.example.com', '88 Lake Dr', 'Reno', 'NV', '89501'],
  ['Emma Lindqvist', 'emma.l@example.com', '31 Aspen Rd', 'Bend', 'OR', '97701'],
  ['Marcus Bell', 'marcus.bell@example.com', '120 River Pkwy', 'Tacoma', 'WA', '98401'],
];

const SERVICES: Array<[string, string, number]> = [
  ['Portrait session', 'One-hour studio portrait session, 20 edited images', 250],
  ['Family session', 'Outdoor family session, up to 6 people', 380],
  ['Wedding half day', 'Four hours of wedding coverage', 1450],
  ['Product shoot', 'Studio product photography, per 10 products', 420],
  ['Headshots (team)', 'On-site team headshots, per person', 85],
  ['Photo editing', 'Advanced retouching, per image', 18],
  ['Print package', 'Archival prints and framing', 160],
  ['Travel fee', 'Travel outside the metro area', 75],
];

function iso(d: Date) {
  return d.toISOString().slice(0, 10);
}
function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

export function seed(opts: SeedOptions = {}) {
  const file = opts.file ?? DEFAULT_DB_PATH;
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(file + suffix)) fs.rmSync(file + suffix);
  }
  const db = openDb(file);
  seedInto(db, opts);
  db.close();
  return file;
}

/** Replaces all rows in an open database (used by the hosted demo's reset button). */
export function seedInto(db: Database.Database, opts: Omit<SeedOptions, 'file'> = {}) {
  db.exec(
    `DELETE FROM invoice_items; DELETE FROM invoices; DELETE FROM retainers; DELETE FROM services; DELETE FROM customers;`,
  );
  if (db.prepare(`SELECT name FROM sqlite_master WHERE name='sqlite_sequence'`).get())
    db.exec(`DELETE FROM sqlite_sequence`);
  const today = opts.today ?? new Date();
  const rand = rng(20261029);

  const insCustomer = db.prepare(
    `INSERT INTO customers (full_name,email,phone,addr1,city,state,zip,country,created_on) VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  const insService = db.prepare(`INSERT INTO services (name,description,unit_price) VALUES (?,?,?)`);
  const insInvoice = db.prepare(
    `INSERT INTO invoices (invoice_no,customer_id,issued_on,due_on,status,total,notes,paid_at,paid_amount) VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  const insItem = db.prepare(
    `INSERT INTO invoice_items (invoice_id,service_id,description,quantity,unit_price) VALUES (?,?,?,?,?)`,
  );
  const insRetainer = db.prepare(
    `INSERT INTO retainers (customer_id,title,monthly_fee,start_date,status) VALUES (?,?,?,?,?)`,
  );

  db.transaction(() => {
    CUSTOMERS.forEach(([name, email, addr, city, state, zip], i) => {
      const useBuyer = opts.buyerEmail && i < 3;
      insCustomer.run(
        name,
        useBuyer ? opts.buyerEmail : email,
        `555-01${String(10 + i).padStart(2, '0')}`,
        addr,
        city,
        state,
        zip,
        'US',
        iso(addDays(today, -400 + i * 7)),
      );
    });
    for (const [n, d, p] of SERVICES) insService.run(n, d, p);

    // 40 invoices across the last 90 days. Statuses are derived from age so the data tells a story.
    for (let k = 0; k < 40; k++) {
      const number = `INV-${1010 + k}`;
      const customerId = (k % CUSTOMERS.length) + 1;
      const issued = addDays(today, -88 + Math.floor((k * 88) / 40));
      const due = addDays(issued, 14);
      const nLines = 1 + Math.floor(rand() * 3);
      const lines: Array<[number, string, number, number]> = [];
      for (let l = 0; l < nLines; l++) {
        const sIdx = Math.floor(rand() * SERVICES.length);
        const [sName, , sPrice] = SERVICES[sIdx]!;
        const qty = sName.includes('per') || sName.includes('editing') ? 1 + Math.floor(rand() * 8) : 1;
        lines.push([sIdx + 1, sName, qty, sPrice]);
      }
      const total = Math.round(lines.reduce((s, [, , q, p]) => s + q * p, 0) * 100) / 100;
      const ageDays = Math.round((today.getTime() - issued.getTime()) / 86400000);
      let status: string;
      if (k === 39) status = 'draft';
      else if (k % 11 === 7) status = 'void';
      else if (ageDays > 45) status = rand() < 0.75 ? 'paid' : 'overdue';
      else if (today > due) status = 'overdue';
      else status = 'sent';
      const paidAt = status === 'paid' ? iso(addDays(issued, 3 + Math.floor(rand() * 10))) : null;
      const notes = k === 28 ? 'Customer asked to split payment; agreed by phone' : null;
      const r = insInvoice.run(
        number,
        customerId,
        iso(issued),
        iso(due),
        status,
        total,
        notes,
        paidAt,
        paidAt ? total : null,
      );
      for (const [sid, desc, q, p] of lines) insItem.run(r.lastInsertRowid, sid, desc, q, p);
    }

    insRetainer.run(8, 'Monthly listing photos', 600, iso(addDays(today, -60)), 'active');
    insRetainer.run(10, 'Event coverage retainer', 900, iso(addDays(today, -30)), 'active');
    insRetainer.run(4, 'Social content package', 350, iso(addDays(today, -5)), 'pending');
    insRetainer.run(2, 'Quarterly headshot refresh', 220, iso(addDays(today, -120)), 'cancelled');
  })();
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('legacy-invoicer/src/seed.ts')) {
  const idx = process.argv.indexOf('--buyer');
  const buyerEmail = idx > -1 ? process.argv[idx + 1] : process.env.FERNHILL_BUYER_EMAIL;
  const file = seed({ buyerEmail });
  console.log(
    `Seeded Fernhill Studio database at ${file}${buyerEmail ? ` (3 customers use ${buyerEmail})` : ''}`,
  );
}
