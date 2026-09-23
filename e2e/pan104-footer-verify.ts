/**
 * 321 Clementi Smart Parking Redemption Engine
 * PAN-104 Quality Gate — Criterion 4 browser verification
 *
 * Renders the built static portal (dist/) in real headless Chromium and measures
 * the new copyright footer against the acceptance wording:
 *   "add footer center at end of page '© <currentyear> Eng Wah Global Pte Ltd.
 *    All Rights Reserved.' make sure it 1 line and small and not hidden by nav
 *    footer menu."
 *
 * Checks per viewport:
 *   - the copyright text renders exactly once, at the end of the page
 *   - it occupies a SINGLE line box (measured via Range.getClientRects())
 *   - it is horizontally centred within its container
 *   - its font size is small (<= 11px)
 *   - it is NOT occluded by the fixed bottom navigation bar at max scroll
 *   - the removed premises-address strings are absent from the rendered DOM
 *
 * Run: bun e2e/pan104-footer-verify.ts
 * Exit code 0 = all assertions hold; 1 = at least one failure.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const DIST = join(ROOT, 'dist');
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  join(process.env.HOME ?? '', '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'),
  join(process.env.HOME ?? '', '.cache/ms-playwright/chromium-1228/chrome-linux64/chrome'),
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].filter(Boolean) as string[];

const VIEWPORTS = [
  { label: 'iPhone SE 1st gen', width: 320, height: 568 },
  { label: 'iPhone 12 mini', width: 375, height: 812 },
  { label: 'iPhone 11 / XR', width: 414, height: 896 },
];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
};

type Check = { name: string; pass: boolean; detail: string };
const results: Check[] = [];
function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
}

function findChrome(): string | null {
  for (const c of CHROME_CANDIDATES) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Minimal CDP client over Bun's built-in WebSocket
// ---------------------------------------------------------------------------
class Cdp {
  private ws!: WebSocket;
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private events: Array<{ method: string; sessionId?: string; params: any }> = [];

  async connect(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error(`CDP socket error: ${String(e)}`));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    };
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30_000);
    });
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

async function waitForDevTools(port: number, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        const json = (await res.json()) as { webSocketDebuggerUrl?: string };
        if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl;
      }
    } catch { /* not up yet */ }
    await Bun.sleep(150);
  }
  throw new Error('Chromium DevTools endpoint never became available');
}

// ---------------------------------------------------------------------------
// Page-side probe
// ---------------------------------------------------------------------------
const PROBE = `(() => {
  const textOf = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim();
  const copyright = Array.from(document.querySelectorAll('p'))
    .find((el) => textOf(el).includes('Eng Wah Global Pte Ltd'));

  const nav = document.querySelector('nav[aria-label="Bottom Navigation"]');
  const out = { found: !!copyright, addressLeaks: [], navFound: !!nav };

  const body = document.body.innerText || '';
  for (const needle of ['321 Clementi Ave 3', 'Carpark Entry via Clementi Ave 3', 'Singapore 129905']) {
    if (body.includes(needle)) out.addressLeaks.push(needle);
  }

  if (!copyright) return out;

  out.text = textOf(copyright);
  const style = getComputedStyle(copyright);
  out.fontSizePx = parseFloat(style.fontSize);
  out.textAlign = style.textAlign;
  out.whiteSpace = style.whiteSpace;
  out.display = style.display;

  // Count rendered line boxes for the text node
  const range = document.createRange();
  range.selectNodeContents(copyright);
  const lineRects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
  out.lineCount = lineRects.length;
  out.lineWidths = lineRects.map((r) => Math.round(r.width * 100) / 100);

  // Scroll to the very end of the document, then measure
  window.scrollTo(0, document.documentElement.scrollHeight);
  const rect = copyright.getBoundingClientRect();
  const parentRect = copyright.parentElement.getBoundingClientRect();
  out.rect = { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right) };
  out.centeredOffsetPx = Math.round(((rect.left - parentRect.left) - (parentRect.right - rect.right)) * 100) / 100;
  out.parentInnerWidth = Math.round(parentRect.width);

  // Element directly under the copyright's centre point must be the copyright itself
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const hit = document.elementFromPoint(cx, cy);
  out.topmostAtCenter = hit ? (hit.tagName + (hit.className ? '.' + String(hit.className).split(' ').join('.') : '')) : null;
  out.occluded = !(hit === copyright || copyright.contains(hit));

  if (nav) {
    const navRect = nav.getBoundingClientRect();
    out.navRect = { top: Math.round(navRect.top), bottom: Math.round(navRect.bottom), height: Math.round(navRect.height) };
    out.verticalGapAboveNavPx = Math.round(navRect.top - rect.bottom);
    out.overlapsNav = rect.bottom > navRect.top;
  }

  // Distance from the copyright's bottom edge to the document end. The footer carries
  // pb-20 (80px) of intentional padding so the line clears the fixed 64px bottom nav,
  // so the remaining distance is expected to be ~80px of padding, not 0.
  out.atDocumentEnd = Math.round(document.documentElement.scrollHeight - (rect.bottom + window.scrollY));
  out.footerPaddingBottomPx = Math.round(parseFloat(getComputedStyle(document.querySelector('footer')).paddingBottom));

  // The copyright must be the LAST in-flow visible text block in the document.
  // Exclude the fixed bottom nav (rendered last in the DOM but out of document flow).
  const inFlow = (el) => {
    let n = el;
    while (n && n !== document.body) {
      if (getComputedStyle(n).position === 'fixed') return false;
      n = n.parentElement;
    }
    return true;
  };
  const allText = Array.from(document.querySelectorAll('p, span, li, h1, h2, h3, a'))
    .filter((el) => textOf(el).length > 0 && el.getBoundingClientRect().height > 0 && inFlow(el));
  const last = allText[allText.length - 1];
  out.isLastTextBlock = !!last && (last === copyright || copyright.contains(last) || last.contains(copyright));
  out.lastTextSample = last ? textOf(last).slice(0, 60) : null;
  return out;
})()`;

async function main() {
  if (!existsSync(join(DIST, 'index.html'))) {
    console.error('[fatal] dist/index.html not found — run `bun run build` first.');
    process.exit(1);
  }

  const chrome = findChrome();
  if (!chrome) {
    console.error('[fatal] No Chromium binary found. Set CHROME_PATH.');
    process.exit(1);
  }

  // 1. Serve the built portal
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      let path = decodeURIComponent(url.pathname);
      if (path.endsWith('/')) path += 'index.html';
      const file = Bun.file(join(DIST, path));
      if (!(await file.exists())) return new Response('Not found', { status: 404 });
      const ext = path.slice(path.lastIndexOf('.'));
      return new Response(file, { headers: { 'Content-Type': MIME[ext] ?? 'application/octet-stream' } });
    },
  });
  const baseUrl = `http://127.0.0.1:${server.port}/`;
  console.log(`[info] serving dist/ at ${baseUrl}`);

  // 2. Launch Chromium
  const debugPort = 9333 + Math.floor(Math.random() * 400);
  const proc = Bun.spawn([
    chrome,
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    `--remote-debugging-port=${debugPort}`,
    '--user-data-dir=/tmp/pan104-chrome-profile',
    'about:blank',
  ], { stdout: 'ignore', stderr: 'ignore' });

  let cdp: Cdp | null = null;
  try {
    const wsUrl = await waitForDevTools(debugPort);
    cdp = new Cdp();
    await cdp.connect(wsUrl);

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);

    for (const vp of VIEWPORTS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: 2,
        mobile: true,
      }, sessionId);

      cdp.drainEvents();
      await cdp.send('Page.navigate', { url: baseUrl }, sessionId);

      // wait for load
      const deadline = Date.now() + 20_000;
      let loaded = false;
      while (Date.now() < deadline) {
        const evts = cdp.drainEvents();
        if (evts.some((e) => e.method === 'Page.loadEventFired')) { loaded = true; break; }
        await Bun.sleep(80);
      }
      if (!loaded) {
        record(`[${vp.width}px] page loaded`, false, 'Page.loadEventFired never fired');
        continue;
      }
      await Bun.sleep(400); // let webfonts settle

      const res = await cdp.send('Runtime.evaluate', {
        expression: PROBE,
        returnByValue: true,
        awaitPromise: false,
      }, sessionId);

      const v = res.result?.value;
      const tag = `[${vp.width}x${vp.height}]`;
      if (!v || !v.found) {
        record(`${tag} copyright present in rendered DOM`, false, JSON.stringify(v));
        continue;
      }

      record(`${tag} copyright present in rendered DOM`, true, v.text);
      record(`${tag} renders on exactly 1 line`, v.lineCount === 1,
        `lineCount=${v.lineCount} lineWidths=${JSON.stringify(v.lineWidths)} parentInnerWidth=${v.parentInnerWidth}px`);
      record(`${tag} font size is small (<= 11px)`, v.fontSizePx <= 11, `font-size=${v.fontSizePx}px`);
      record(`${tag} horizontally centred`, Math.abs(v.centeredOffsetPx) <= 2,
        `left/right offset delta=${v.centeredOffsetPx}px text-align=${v.textAlign}`);
      record(`${tag} not occluded by the fixed bottom nav`, v.occluded === false && v.overlapsNav === false,
        `gap above nav=${v.verticalGapAboveNavPx}px navHeight=${v.navRect?.height}px topmostAtCenter=${v.topmostAtCenter}`);
      record(`${tag} is the last text block on the page`, v.isLastTextBlock === true,
        `last text block = "${v.lastTextSample}"`);
      record(`${tag} tail distance is only nav-clearance padding`, v.atDocumentEnd <= v.footerPaddingBottomPx + 4,
        `distance from document end=${v.atDocumentEnd}px footer padding-bottom=${v.footerPaddingBottomPx}px`);
      record(`${tag} no removed premises-address text rendered`, v.addressLeaks.length === 0,
        v.addressLeaks.length ? `leaked: ${v.addressLeaks.join(' | ')}` : 'none');
    }
  } finally {
    cdp?.close();
    proc.kill();
    server.stop(true);
  }

  console.log('\n=== PAN-104 Criterion 4 — browser verification ===');
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : '  →  ' + r.detail}`);
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
