#!/usr/bin/env node
/**
 * Records the demo video draft from a running mock demo: headless Chrome drives the real console, legacy app,
 * website, portal and PayPal simulator, with a visible cursor and burned-in captions. Frames come from the
 * DevTools screencast and are assembled with ffmpeg. Writes video/out/paypal-retrofit-demo.mp4 and a matching
 * .srt caption file (for YouTube). Add the voice-over afterwards; docs/demo-script.md has the script.
 *
 *   pnpm retrofit demo --fresh          # in another terminal
 *   node scripts/record-demo.mjs [baseUrl] [chromePath]
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = (process.argv[2] ?? 'http://localhost:8787').replace(/\/$/, '');
const chrome =
  process.argv[3] ??
  process.env.CHROME_PATH ??
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((p) => fs.existsSync(p));
if (!chrome) throw new Error('Chrome not found; pass its path as the second argument');

const outDir = path.resolve('video/out');
const frames = path.join(outDir, 'frames');
fs.rmSync(frames, { recursive: true, force: true });
fs.mkdirSync(frames, { recursive: true });
const W = 1440;
const H = 810;
const SCALE = 1920 / W;

// ---- Chrome over the DevTools protocol
const port = 9400 + Math.floor(Math.random() * 400);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'retrofit-video-'));
const proc = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--force-color-profile=srgb',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; ; i++) {
  try {
    await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    break;
  } catch {
    if (i > 50) throw new Error('Chrome did not start');
    await sleep(200);
  }
}
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
let id = 0;
const pending = new Map();
const listeners = new Set();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method) for (const l of listeners) l(msg);
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, (msg) =>
      msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result),
    );
    ws.send(JSON.stringify({ id: n, method, params }));
  });
const once = (method, ms = 15000) =>
  new Promise((resolve) => {
    const t = setTimeout(() => (listeners.delete(l), resolve(null)), ms);
    const l = (msg) => msg.method === method && (clearTimeout(t), listeners.delete(l), resolve(msg));
    listeners.add(l);
  });

// ---- frames: the screencast sends one when the page repaints; timestamps give each frame its duration
const shots = [];
listeners.add((msg) => {
  if (msg.method !== 'Page.screencastFrame') return;
  const file = path.join(frames, `f${String(shots.length).padStart(5, '0')}.jpg`);
  fs.writeFileSync(file, Buffer.from(msg.params.data, 'base64'));
  shots.push({ file, t: msg.params.metadata.timestamp });
  void send('Page.screencastFrameAck', { sessionId: msg.params.sessionId });
});

// ---- on every page: a caption bar and a cursor that moves to what it clicks
const HELPER = `(() => {
  if (window.__demo) return;
  const css = 'position:fixed;z-index:2147483646;pointer-events:none;';
  const ready = (fn) => (document.body ? fn() : document.addEventListener('DOMContentLoaded', fn));
  // data: pages (title cards) have no storage.
  const S = (() => { try { return window.sessionStorage; } catch { return {}; } })();
  let cap, cur;
  const ensure = () => {
    if (!cap) {
      cap = document.createElement('div');
      cap.style.cssText = css + 'left:50%;bottom:34px;transform:translateX(-50%);max-width:78%;padding:12px 22px;border-radius:12px;background:rgba(10,14,22,.86);color:#fff;font:600 21px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.35);transition:opacity .3s';
      document.documentElement.appendChild(cap);
    }
    if (!cur) {
      cur = document.createElement('div');
      cur.style.cssText = css + 'width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;border:3px solid #fff;background:rgba(29,78,216,.85);box-shadow:0 2px 10px rgba(0,0,0,.45);transition:left .55s ease,top .55s ease,transform .15s;left:' + (S.__cx || 720) + 'px;top:' + (S.__cy || 420) + 'px;opacity:' + (S.__cx ? 1 : 0);
      document.documentElement.appendChild(cur);
    }
  };
  window.__demo = {
    caption(text) {
      ready(() => {
        ensure();
        S.__cap = text || '';
        cap.textContent = text || '';
        cap.style.opacity = text ? 1 : 0;
      });
    },
    move(x, y) {
      ensure();
      S.__cx = x;
      S.__cy = y;
      cur.style.left = x + 'px';
      cur.style.top = y + 'px';
      cur.style.opacity = 1;
    },
    press() {
      cur.style.transform = 'scale(.7)';
      setTimeout(() => (cur.style.transform = ''), 180);
    },
  };
  ready(() => { ensure(); window.__demo.caption(S.__cap || ''); });
})();`;

const js = async (expression) =>
  (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value;
const go = async (url, settle = 1800, text) => {
  // The next scene's caption is stored before navigating, so the new page opens with it.
  if (text !== undefined) {
    mark(text);
    await js(`(() => { try { sessionStorage.__cap = ${JSON.stringify(text)}; } catch {} })()`);
  }
  const loaded = once('Page.loadEventFired');
  const r = await send('Page.navigate', {
    url: url.startsWith('data:') || /^https?:/.test(url) ? url : base + url,
  });
  // A change of #page in the console is a same-document navigation: no load event follows.
  if (r.loaderId) await loaded;
  // Coming from a title card (no storage), the new page needs the caption set again.
  if (text !== undefined) await js(`window.__demo?.caption(${JSON.stringify(text)})`);
  await sleep(settle);
};
const cues = [];
const mark = (text) => {
  const now = (Date.now() - started) / 1000;
  if (cues.length && cues[cues.length - 1].end == null) cues[cues.length - 1].end = now;
  if (text) cues.push({ start: now, end: null, text });
};
const caption = async (text) => {
  mark(text);
  await js(`window.__demo?.caption(${JSON.stringify(text)})`);
};
/** Finds a visible element by its text (optionally inside a selector), moves the cursor to it and clicks. */
const click = async (
  text,
  { within = 'button, a, label, summary, [role=tab], [role=menuitem]', shadow = false, pause = 900 } = {},
) => {
  const at = await js(`(() => {
    const roots = [document, ...(${shadow} ? [...document.querySelectorAll('*')].map((e) => e.shadowRoot).filter(Boolean) : [])];
    for (const r of roots)
      for (const el of r.querySelectorAll(${JSON.stringify(within)})) {
        const t = (el.innerText || el.value || '').trim();
        const b = el.getBoundingClientRect();
        if (t.startsWith(${JSON.stringify(text)}) && b.width && b.height) {
          el.scrollIntoView({ block: 'nearest' });
          const c = el.getBoundingClientRect();
          return { x: c.left + Math.min(c.width / 2, 120), y: c.top + c.height / 2 };
        }
      }
    return null;
  })()`);
  if (!at) throw new Error(`Nothing to click: ${text}`);
  await js(`window.__demo.move(${at.x}, ${at.y})`);
  await sleep(650);
  await js('window.__demo.press()');
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
  await sleep(pause);
};
/** Clicks into a field (by CSS selector, in the page or a widget's Shadow DOM) and types like a person. */
const type = async (selector, text, { shadow = false, perChar = 38 } = {}) => {
  const at = await js(`(() => {
    const roots = [document, ...(${shadow} ? [...document.querySelectorAll('*')].map((e) => e.shadowRoot).filter(Boolean) : [])];
    for (const r of roots) {
      const el = r.querySelector(${JSON.stringify(selector)});
      if (el) { el.focus(); const b = el.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2 }; }
    }
    return null;
  })()`);
  if (!at) throw new Error(`No field: ${selector}`);
  await js(`window.__demo.move(${at.x}, ${at.y})`);
  await sleep(500);
  for (const ch of text) {
    await send('Input.insertText', { text: ch });
    await sleep(perChar);
  }
  await sleep(400);
};
const scroll = async (y) => {
  await js(`window.scrollTo({ top: ${y}, behavior: 'smooth' })`);
  await sleep(1100);
};
const api = async (p, init) => {
  const r = await fetch(base + p, init);
  if (!r.ok) throw new Error(`${p}: ${r.status} ${await r.text()}`);
  return r.json();
};
const post = (p, body = {}) =>
  api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const card = (title, sub, small = '') =>
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(`<!doctype html><html><body style="margin:0;height:100vh;display:grid;place-items:center;background:radial-gradient(1200px 600px at 30% 20%,#1e3a8a 0%,#0b1220 55%);color:#fff;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif">
<div style="max-width:1060px;padding:40px"><div style="display:flex;align-items:center;gap:16px;margin-bottom:28px"><div style="width:52px;height:52px;border-radius:14px;background:#3b82f6;display:grid;place-items:center;font-weight:800;font-size:28px">R</div><div style="font-size:30px;font-weight:700">paypal-retrofit</div></div>
<div style="font-size:58px;font-weight:800;line-height:1.1;letter-spacing:-.01em">${title}</div><div style="font-size:26px;color:#cbd5e1;margin-top:22px;line-height:1.45">${sub}</div>${small ? `<div style="font-size:19px;color:#94a3b8;margin-top:30px">${small}</div>` : ''}</div></body></html>`);

// ---- the run
let started = Date.now();
try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('retrofit.tour.done', '1') } catch {}\n${HELPER}`,
  });
  await send('Emulation.setDeviceMetricsOverride', {
    width: W,
    height: H,
    deviceScaleFactor: SCALE,
    mobile: false,
  });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await send('Emulation.setTimezoneOverride', { timezoneId: 'America/Los_Angeles' });

  // Start from the demo's first state: 22 invoices ready, nothing in PayPal.
  await post('/api/demo/reset');
  await go(
    card(
      'Give any existing business a <span style="color:#93c5fd">PayPal brain</span>.',
      "Open source. It connects PayPal to the system a small business already runs on, and keeps both in step, with Claude doing the integration work and the owner's rules deciding what moves money.",
      'PayPal AI Hackathon 2026 · MIT licence · runs here against the built-in PayPal simulator',
    ),
    300,
  );
  await send('Page.startScreencast', {
    format: 'jpeg',
    quality: 88,
    maxWidth: 1920,
    maxHeight: 1080,
    everyNthFrame: 1,
  });
  started = Date.now();
  await sleep(6500);

  // 1. The old system
  await go(
    '/fernhill/',
    1800,
    'Fernhill Studio runs on an old invoicing app. 17 invoices are overdue, and every payment is marked paid by hand.',
  );
  await sleep(4200);
  await scroll(320);
  await sleep(2600);

  // 2. Connect what they have
  await go(
    '/#setup',
    1800,
    'retrofit connects to what the business already has: a database, CSV exports, an Excel file or a Google Sheet.',
  );
  await sleep(3800);
  await click('Try the sample business');
  await click('Read my data', { pause: 2200 });
  await click('Next: Check the mapping', { pause: 900 });
  await click('Map my data', { pause: 2200 });
  await caption(
    'Claude maps their tables to PayPal and explains each choice. Nothing changes until the owner goes live.',
  );
  await sleep(4200);

  // 3. Today
  await go('/', 1800, 'The console opens on Today: what needs the owner, with one button each.');
  await sleep(3800);
  await click('Send now', { pause: 2600 });
  await caption("One click sends every open invoice through PayPal, under Fernhill's own invoice numbers.");
  await sleep(3200);

  // 4. A new invoice from one sentence
  await caption('New invoices: type a sentence, or snap a photo of a paper job sheet and Claude reads it.');
  await click('+ New invoice', { within: '.today-actions button' });
  await type('.ni-text', 'Invoice Maya Okafor 2 hours at $95 for retouching, due Friday');
  await click('Read it', { pause: 2000 });
  await caption(
    'The owner checks the draft. It goes into their own database, then out to the customer through PayPal.',
  );
  await sleep(2200);
  await click('Add and send', { pause: 2600 });
  await sleep(1500);

  // 5. The customer pays
  const added = (await api('/api/ledger')).find((r) => r.number === 'INV-1050');
  await go(
    added.payLink.replace(/^https?:\/\/[^/]+/, ''),
    1800,
    'The customer pays on PayPal (here, the built-in simulator).',
  );
  await sleep(2400);
  await click('Pay ', { within: 'button', pause: 2200 });
  await go(
    '/fernhill/',
    1800,
    "PayPal's signed webhook comes back, and the old app's invoice is marked paid on its own.",
  );
  await js(
    `[...document.querySelectorAll('tr')].find((r) => r.innerText.includes('INV-1050'))?.scrollIntoView({ block: 'center' })`,
  );
  await sleep(1200);
  await js(
    `(() => { const r = [...document.querySelectorAll('tr')].find((r) => r.innerText.includes('INV-1050')); if (r) r.style.outline = '3px solid #22c55e'; })()`,
  );
  await sleep(3600);

  // 6. Their own website
  await go('/site', 1800, 'One line of script adds "Pay a bill" to the website they already have.');
  await sleep(3000);
  await js(`document.getElementById('pay').scrollIntoView({ behavior: 'smooth', block: 'center' })`);
  await sleep(1400);
  await type('input[name=number]', 'INV-1012', { shadow: true });
  const priya = (await api('/api/ledger')).find((r) => r.number === 'INV-1012');
  await type('input[name=email]', priya.customerEmail, { shadow: true, perChar: 25 });
  await click('Find my bill', { within: 'button', shadow: true, pause: 1800 });
  await caption(
    "Invoice number and email, then straight to PayPal. Paper invoices get a pay slip with PayPal's QR code.",
  );
  await sleep(4000);

  // 7. The customer's portal and autopay
  const customers = await api('/api/customers');
  const daniel = customers.find((c) => c.name === 'Daniel Reyes') ?? customers.find((c) => c.openInvoices);
  await go(
    new URL(daniel.portalUrl).pathname,
    1800,
    'Every customer gets a private portal: pay several invoices at once, ask for more time, or turn on autopay.',
  );
  await sleep(3400);
  await js(
    `document.querySelector('form[action$="/autopay"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' })`,
  );
  await sleep(1200);
  await click('Set up autopay with PayPal', { within: 'button', pause: 1800 });
  await caption('Autopay uses PayPal Vault: the customer saves PayPal once and approves it at PayPal.');
  await sleep(2400);
  await click('Agree and save PayPal', { within: 'button', pause: 2200 });
  await caption(
    "From now on their invoices are paid on the due date, under the owner's rules. No more reminders.",
  );
  await sleep(3800);

  // 8. Agents on both sides
  const priyaPortal = customers.find((c) => c.name === 'Priya Natarajan')?.portalUrl;
  const rpc = async (name, args) => {
    const r = await fetch(`${base}/mcp/shop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    return JSON.parse((await r.json()).result.content[0].text);
  };
  const mine = await rpc('my_invoices', { portal_link: priyaPortal });
  const oldest = mine.invoices.filter((i) => i.payableOnline).slice(0, 2);
  const co = await rpc('pay_my_invoices', {
    portal_link: priyaPortal,
    invoices: oldest.map((i) => i.number),
    agent: 'Claude',
  });
  const line = (k, v) => `<div style="margin:6px 0"><span style="color:#93c5fd">${k}</span> ${v}</div>`;
  await go(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(`<!doctype html><html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0b1220;color:#e2e8f0;font:20px/1.5 ui-monospace,Menlo,Consolas,monospace">
<div style="width:1120px"><div style="font:600 22px system-ui,sans-serif;color:#94a3b8;margin-bottom:14px">A customer's own AI assistant, over MCP · real calls to Fernhill's endpoint</div>
<div style="background:#111827;border:1px solid #1f2937;border-radius:14px;padding:24px 28px">
<div style="font:600 21px system-ui,sans-serif;color:#fff;margin-bottom:12px">"What do I owe Fernhill Studio? Pay the two oldest."</div>
${line('→ my_invoices', `{ portal_link }`)}${line('←', `${mine.invoices.length} open · balance ${mine.balance.toFixed(2)} ${mine.currency} · overdue ${mine.overdue.toFixed(2)}`)}
${line('→ pay_my_invoices', `{ invoices: [${oldest.map((i) => `"${i.number}"`).join(', ')}], agent: "Claude" }`)}${line('←', `one PayPal checkout · ${co.total.toFixed(2)} ${co.currency}`)}
${line('←', `approveUrl: ${co.approveUrl.replace(/^https?:\/\/[^/]+/, '')}`)}
<div style="margin-top:14px;font:600 20px system-ui,sans-serif;color:#86efac">The assistant hands over a PayPal link. The customer approves the payment.</div></div></div></body></html>`),
    600,
  );
  await caption(
    "A customer's own assistant can check and pay their bills, and shoppers' agents can buy, but only ever with a PayPal link a person approves.",
  );
  await sleep(6500);

  // 9. The owner's rules
  await go(
    '/#collections',
    1800,
    "Collections decides who to remind, who promised to pay and who asked for a plan. Nothing goes out without the owner's rules.",
  );
  await sleep(4200);
  await click('Run playbook', { within: 'button', pause: 2400 });
  await go('/#approvals', 1200);
  await caption(
    "Reminders and plan offers wait for the owner's OK, each with the rule that applied. The agent proposes; the rules decide.",
  );
  await sleep(3600);

  // 10. Going live
  await go('/#golive', 1200);
  await caption(
    'Go live walks from the simulator to the PayPal sandbox to real payments, checking each step.',
  );
  await sleep(4800);

  await caption('');
  await go(
    card(
      'paypal-retrofit',
      'PayPal Invoicing, Orders, Vault, Webhooks and the Agent Toolkit, with Claude. SQLite, Postgres, MySQL, CSV, Excel or a Google Sheet.',
      'github.com/Thinkelution/paypal-retrofit · MIT · run it with Docker, Codespaces or Render',
    ),
    300,
  );
  await sleep(6000);
  if (cues.length && cues[cues.length - 1].end == null)
    cues[cues.length - 1].end = (Date.now() - started) / 1000;
  await send('Page.stopScreencast');
  await sleep(300);
} finally {
  ws.close();
  proc.kill();
}

// ---- assemble: each frame lasts until the next one; then a constant 30 fps H.264 file
if (shots.length < 2) throw new Error('No frames were captured');
const list = shots
  .map((s, i) => {
    const next = shots[i + 1]?.t ?? s.t + 1;
    return `file '${s.file.replace(/\\/g, '/')}'\nduration ${Math.max(0.001, next - s.t).toFixed(3)}`;
  })
  .join('\n');
fs.writeFileSync(
  path.join(outDir, 'frames.txt'),
  `${list}\nfile '${shots[shots.length - 1].file.replace(/\\/g, '/')}'\n`,
);
const mp4 = path.join(outDir, 'paypal-retrofit-demo.mp4');
execFileSync(
  'ffmpeg',
  [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    path.join(outDir, 'frames.txt'),
    '-vf',
    'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p',
    '-r',
    '30',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '20',
    '-movflags',
    '+faststart',
    mp4,
  ],
  { stdio: 'inherit' },
);
// Screencast time starts at the first frame; captions were timed from the same moment.
const ts = (t) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};
const offset = shots[0].t - started / 1000;
fs.writeFileSync(
  path.join(outDir, 'paypal-retrofit-demo.srt'),
  cues.map((c, i) => `${i + 1}\n${ts(c.start - offset)} --> ${ts(c.end - offset)}\n${c.text}\n`).join('\n'),
);
fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
const seconds = shots[shots.length - 1].t - shots[0].t;
console.log(`${mp4}\n${shots.length} frames, ${seconds.toFixed(1)} s, ${cues.length} captions`);
