#!/usr/bin/env node
/**
 * Captures the product screenshots used by the landing page (site/assets) from a running demo.
 * Drives headless Chrome over the DevTools protocol, so pages can finish rendering and be clicked.
 *
 *   pnpm retrofit demo --fresh          # in another terminal, then stage some activity
 *   node scripts/capture-screenshots.mjs [baseUrl] [chromePath]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args.splice(onlyIdx, 2)[1]?.split(',') : null;
const base = (args[0] ?? 'http://localhost:8787').replace(/\/$/, '');
const chrome =
  args[1] ??
  process.env.CHROME_PATH ??
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((p) => fs.existsSync(p));
if (!chrome) throw new Error('Chrome not found; pass its path as the second argument');

const out = path.resolve('site/assets');
fs.mkdirSync(out, { recursive: true });
const port = 9300 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'retrofit-shots-'));
const proc = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForChrome() {
  for (let i = 0; i < 50; i++) {
    try {
      return await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch {
      await sleep(200);
    }
  }
  throw new Error('Chrome did not start');
}

async function session() {
  const target = await (
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
  ).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  const waiters = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) {
      for (const w of waiters.splice(0)) w(msg);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, (msg) =>
        msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result),
      );
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const waitFor = (method, ms = 15000) =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      const check = (msg) => (msg.method === method ? (clearTimeout(t), resolve(msg)) : waiters.push(check));
      waiters.push(check);
    });
  return {
    send,
    waitFor,
    close: async () => {
      ws.close();
      await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
    },
  };
}

const SHOTS = [
  { file: 'console.png', url: '/', w: 1440, h: 900 },
  { file: 'drawer.png', url: '/', w: 1440, h: 900, click: 'INV-1022' },
  { file: 'collections.png', url: '/#collections', w: 1440, h: 900 },
  { file: 'insights.png', url: '/#insights', w: 1440, h: 1180 },
  { file: 'mapping.png', url: '/#mapping', w: 1440, h: 1000 },
  { file: 'discrepancies.png', url: '/#discrepancies', w: 1440, h: 760 },
  { file: 'approvals.png', url: '/#approvals', w: 1440, h: 760 },
  { file: 'webhooks.png', url: '/#activity', w: 1440, h: 760 },
  { file: 'legacy.png', url: '/fernhill/', w: 1280, h: 800, scheme: 'light' },
  { file: 'mobile.png', url: '/', w: 390, h: 844, mobile: true },
  { file: 'digest.png', url: '/#digest', w: 1440, h: 1000 },
  { file: 'customers.png', url: '/c/brightside/#customers', w: 1440, h: 1000 },
  { file: 'shop.png', url: '/#shop', w: 1440, h: 1000 },
  { file: 'practice.png', url: '/#practice', w: 1440, h: 760 },
  { file: 'storefront.png', url: '/shop', w: 1100, h: 860, scheme: 'light' },
  { file: 'mcp.png', url: '/', w: 1440, h: 900, clicks: ['Connect Claude (MCP)'] },
  {
    file: 'setup-rules.png',
    url: '/#setup',
    w: 1440,
    h: 1000,
    clicks: [
      'Try the sample business',
      'Read my data',
      'Next: Check the mapping',
      'Map my data',
      'Next: Set your rules',
    ],
  },
  {
    file: 'setup.png',
    url: '/#setup',
    w: 1440,
    h: 1000,
    clicks: [
      'Try the sample business',
      'Read my data',
      'Next: Check the mapping',
      'Map my data',
      'Next: Set your rules',
      'Next: Preview and go live',
    ],
  },
];

try {
  await waitForChrome();
  const ledger = await (await fetch(`${base}/api/ledger`)).json();
  const unpaid = ledger.find((r) => r.entity === 'invoice' && r.paypalStatus === 'SENT');
  const customers = await (await fetch(`${base}/c/brightside/api/customers`)).json().catch(() => []);
  const portal = customers.find?.((c) => c.name === 'Rockridge Florist')?.portalUrl;
  if (portal)
    SHOTS.push({ file: 'portal.png', url: new URL(portal).pathname, w: 900, h: 900, scheme: 'light' });
  if (unpaid?.payLink)
    SHOTS.push({
      file: 'pay.png',
      url: unpaid.payLink.replace(/^https?:\/\/[^/]+/, ''),
      w: 900,
      h: 620,
      scheme: 'light',
    });

  for (const s of SHOTS.filter((x) => !only || only.includes(x.file))) {
    const page = await session();
    await page.send('Page.enable');
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: s.w,
      height: s.h,
      deviceScaleFactor: s.mobile ? 2 : 1,
      mobile: !!s.mobile,
    });
    await page.send('Emulation.setTimezoneOverride', { timezoneId: 'America/Los_Angeles' });
    await page.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: s.scheme ?? 'dark' }],
    });
    const loaded = page.waitFor('Page.loadEventFired');
    await page.send('Page.navigate', { url: base + s.url });
    await loaded;
    await sleep(2500);
    if (s.click) {
      const { result } = await page.send('Runtime.evaluate', {
        returnByValue: true,
        expression: `(() => {
          const row = [...document.querySelectorAll('.ag-row')].find((r) => r.innerText.includes(${JSON.stringify(s.click)}));
          const b = row?.getBoundingClientRect();
          return b ? { x: b.left + 120, y: b.top + b.height / 2 } : null;
        })()`,
      });
      const at = result.value;
      if (at) {
        for (const type of ['mousePressed', 'mouseReleased'])
          await page.send('Input.dispatchMouseEvent', {
            type,
            x: at.x,
            y: at.y,
            button: 'left',
            clickCount: 1,
          });
      }
      await sleep(1200);
    }
    // Click through buttons and labels by their text (the setup wizard, dialogs).
    for (const text of s.clicks ?? []) {
      await page.send('Runtime.evaluate', {
        expression: `(() => {
          const el = [...document.querySelectorAll('button, label, a')].find((e) => e.innerText.trim().startsWith(${JSON.stringify(text)}));
          el?.click();
        })()`,
      });
      await sleep(1500);
    }
    if (s.clicks) await page.send('Runtime.evaluate', { expression: 'window.scrollTo(0, 0)' });
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, s.file), Buffer.from(data, 'base64'));
    console.log(`${s.file}  ${s.w}x${s.h}`);
    await page.close();
  }
} finally {
  proc.kill();
  await sleep(300);
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    // Chrome can hold files for a moment on Windows; the temp folder is harmless.
  }
}
