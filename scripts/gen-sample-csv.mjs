// Generates the Brightside Plumbing sample CSVs (a fictional business) used by the setup wizard.
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

const clients = [
  ['Harbor View Apartments', 'Maya Chen', 'Oakland'],
  ['Juniper Street Bakery', 'Luis Ortega', 'Berkeley'],
  ['Redwood Dental Group', 'Priya Nair', 'Oakland'],
  ['Castro Valley Yoga', 'Hannah Lee', 'Castro Valley'],
  ['Lakeshore Property Mgmt', 'Owen Brooks', 'Oakland'],
  ['Mission Peak Brewing', 'Diego Ramos', 'Fremont'],
  ['Elmwood Day School', 'Grace Kim', 'Berkeley'],
  ['Alameda Auto Spa', 'Sam Patel', 'Alameda'],
  ['Piedmont Residence (Wu)', 'Jenny Wu', 'Piedmont'],
  ['Grand Lake Theater Cafe', 'Marcus Bell', 'Oakland'],
  ['Hayward Fitness Hub', 'Tasha Green', 'Hayward'],
  ['Rockridge Florist', 'Nora Fischer', 'Oakland'],
];
const csv = (rows) =>
  rows
    .map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(','))
    .join('\n') + '\n';

fs.writeFileSync(
  path.join(out, 'clients.csv'),
  csv([
    ['id', 'company', 'contact_name', 'email', 'phone', 'city', 'state', 'zip'],
    ...clients.map(([company, contact, city], i) => [
      i + 1,
      company,
      contact,
      `${contact.split(' ')[0].toLowerCase()}.${String(company)
        .split(' ')[0]
        .toLowerCase()
        .replace(/[^a-z]/g, '')}@example.com`,
      `(510) 555-01${String(10 + i).padStart(2, '0')}`,
      city,
      'CA',
      [
        '94607',
        '94704',
        '94610',
        '94546',
        '94606',
        '94538',
        '94705',
        '94501',
        '94611',
        '94610',
        '94541',
        '94618',
      ][i],
    ]),
  ]),
);

const jobs = [
  ['Water heater replacement (50 gal)', 1, 1450],
  ['Drain cleaning, main line', 2.5, 145],
  ['Leak detection and repair', 3, 135],
  ['Fixture install: faucet + disposal', 1, 420],
  ['Backflow test and certification', 1, 185],
  ['Emergency call-out (after hours)', 1, 225],
  ['Sewer camera inspection', 1, 295],
  ['Repipe: kitchen supply lines', 6, 125],
];
const addDays = (iso, d) => {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + d);
  return t.toISOString().slice(0, 10);
};
const bills = [
  [
    'id',
    'reference',
    'client_id',
    'issued_on',
    'due_on',
    'amount_due',
    'state',
    'memo',
    'paypal_id',
    'pay_link',
    'paid_on',
  ],
];
const items = [['id', 'bill_id', 'description', 'hours', 'rate']];
let itemId = 1;
const start = '2026-08-03';
for (let k = 0; k < 30; k++) {
  const id = k + 1;
  const client = 1 + Math.floor(rand() * clients.length);
  const issued = addDays(start, Math.floor(k * 3.1));
  const due = addDays(issued, 15);
  const n = 1 + Math.floor(rand() * 2);
  let total = 0;
  for (let j = 0; j < n; j++) {
    const [desc, qty, rate] = jobs[Math.floor(rand() * jobs.length)];
    total += qty * rate;
    items.push([itemId++, id, desc, qty, rate]);
  }
  total = Math.round(total * 100) / 100;
  let state = 'billed';
  let paid = '';
  const roll = rand();
  if (k < 18 && roll < 0.7) {
    state = 'settled';
    paid = addDays(due, Math.floor(rand() * 9) - 4);
  }
  if (k === 9) state = 'written_off';
  if (k >= 28) state = 'draft';
  let memo = '';
  if (k === 5) memo = 'Owner asked to split this into two payments';
  if (k === 19) memo = 'Promised to pay by the 15th (voicemail)';
  if (k === 21) memo = 'Gate code 4410; call before arriving';
  bills.push([id, `BP-${2400 + id}`, client, issued, due, total.toFixed(2), state, memo, '', '', paid]);
}
fs.writeFileSync(path.join(out, 'bills.csv'), csv(bills));
fs.writeFileSync(path.join(out, 'bill_items.csv'), csv(items));
console.log(
  `wrote ${bills.length - 1} bills, ${items.length - 1} items, ${clients.length} clients to ${out}`,
);
