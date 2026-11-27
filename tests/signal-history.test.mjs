import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateBars } from '../scripts/fetch-calendar.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function createSandbox() {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'inline <script> block must exist');

  const elements = new Map();
  const makeEl = (id) => ({
    id,
    innerHTML: '',
    textContent: '',
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {},
    closest() { return null; }
  });
  const getEl = (sel) => {
    if (!elements.has(sel)) elements.set(sel, makeEl(sel));
    return elements.get(sel);
  };

  const store = new Map();
  const noop = () => {};
  const sandbox = {
    console, Math, Date, Number, String, Boolean, Array, Object, JSON, RegExp, Error, Promise, Intl,
    encodeURIComponent, decodeURIComponent, isFinite: Number.isFinite, isNaN: Number.isNaN,
    setTimeout: noop, clearTimeout: noop, setInterval: () => 1, clearInterval: noop,
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' }),
    localStorage: {
      get length() { return store.size; },
      key: (idx) => Array.from(store.keys())[idx] ?? null,
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
      clear: () => store.clear()
    },
    document: {
      querySelector: getEl,
      querySelectorAll: () => [],
      getElementById: (id) => getEl('#' + id),
      createElement: () => makeEl('created')
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(match[1], ctx);
  // Halaman memuat <script src="signal-engine.js"> terpisah. Tanpa file ini
  // engineOf() null -> signalDirectionCore tidak pernah menghasilkan
  // basis 'engine', sehingga backtest kalender selalu 0 sampel.
  // (require tidak ada di vm, jadi blok --selftest di bawah tidak ikut jalan.)
  vm.runInContext(readFileSync(join(ROOT, 'signal-engine.js'), 'utf8'), ctx);
  return { ctx, elements, store };
}

test('aggregateBars resamples 1m OHLC bars into 5m candles cleanly', () => {
  const bars1m = [
    { k: 100, o: 10, h: 12, l: 9.5, c: 11 },
    { k: 101, o: 11, h: 15, l: 10.5, c: 14 },
    { k: 102, o: 14, h: 14.5, l: 8, c: 12 },
    { k: 105, o: 12, h: 13, l: 11.5, c: 12.8 }
  ];
  const agg = aggregateBars(bars1m, 5);
  assert.equal(agg.length, 2);
  assert.deepEqual(agg[0], { k: 100, o: 10, h: 15, l: 8, c: 12 });
  assert.deepEqual(agg[1], { k: 105, o: 12, h: 13, l: 11.5, c: 12.8 });
});

test('simulateTradeOnBars evaluates conservative SL priority, TP1 BE-lock, TP2, and OPEN trades', () => {
  const { ctx } = createSandbox();

  // SL and TP1 both inside same bar -> conservative LOSS (-1R)
  const bothHit = vm.runInContext(`simulateTradeOnBars('long', 100, 99, 101, 102, [{ o: 100, h: 101.5, l: 98.8, c: 101 }])`, ctx);
  assert.equal(bothHit.outcome, 'LOSS');
  assert.equal(bothHit.closed, true);
  assert.equal(bothHit.r, -1);

  // TP1 hit then TP2 hit -> WIN_TP2 (+1.5R)
  const fullWin = vm.runInContext(`simulateTradeOnBars('long', 100, 99, 101, 102, [{ o: 100, h: 101.2, l: 99.8, c: 101.1 }, { o: 101.1, h: 102.3, l: 100.8, c: 102.1 }])`, ctx);
  assert.equal(fullWin.outcome, 'WIN_TP2');
  assert.equal(fullWin.closed, true);
  assert.equal(fullWin.r, 1.5);

  // TP1 hit then pullback to Entry (BE) -> WIN_TP1 (+0.5R)
  const tp1Be = vm.runInContext(`simulateTradeOnBars('short', 100, 101, 99, 98, [{ o: 100, h: 100.2, l: 98.9, c: 99.1 }, { o: 99.1, h: 100.1, l: 99.0, c: 99.9 }])`, ctx);
  assert.equal(tp1Be.outcome, 'WIN_TP1');
  assert.equal(tp1Be.closed, true);
  assert.equal(tp1Be.r, 0.5);

  // Neither hit -> OPEN (excluded from closed Winrate)
  const openPos = vm.runInContext(`simulateTradeOnBars('long', 100, 99, 101, 102, [{ o: 100, h: 100.5, l: 99.6, c: 100.4 }])`, ctx);
  assert.equal(openPos.outcome, 'OPEN');
  assert.equal(openPos.closed, false);
  assert.equal(openPos.r, 0.4);

  // fillMode 'limit' (regresi bug fill terbalik): order BUY hanya terisi bila
  // harga MENYENTUH level entry (low bar <= entry). Bar yang tidak menyentuh
  // tidak boleh dianggap terisi.
  const noTouch = vm.runInContext(
    `simulateTradeOnBars('long', 95, 94, 96, 97, [{ o: 100, h: 101, l: 96.5, c: 100 }, { o: 100, h: 101, l: 96.8, c: 100 }], 'gold', 1, 0, 'limit')`,
    ctx);
  assert.equal(noTouch.outcome, 'NOFILL');
  assert.equal(noTouch.closed, false);
  assert.equal(noTouch.r, 0);

  const touched = vm.runInContext(
    `simulateTradeOnBars('long', 95, 94, 96, 97, [{ o: 95.5, h: 95.8, l: 94.5, c: 94.8 }], 'gold', 6, 0, 'limit')`,
    ctx);
  assert.equal(touched.outcome, 'OPEN');
  assert.equal(touched.closed, false);
  assert.ok(touched.r < 0, 'setelah terisi, mark-to-market memakai harga bar');
});

test('summarizeTradeSet calculates PROFIT, LOSS, Winrate, Profit Factor, and excludes OPEN from Winrate', () => {
  const { ctx } = createSandbox();

  const profitSum = vm.runInContext(`summarizeTradeSet([
    { closed: true, outcome: 'WIN_TP2', r: 1.5 },
    { closed: true, outcome: 'WIN_TP1', r: 0.5 },
    { closed: true, outcome: 'LOSS', r: -1.0 },
    { closed: false, outcome: 'OPEN', r: -0.3 }
  ])`, ctx);
  assert.equal(profitSum.closedCount, 3);
  assert.equal(profitSum.openCount, 1);
  assert.equal(profitSum.winsCount, 2);
  assert.equal(profitSum.winRatePct, 66.7);
  assert.equal(profitSum.netR, 1);
  assert.equal(profitSum.profitFactor, 2);
  assert.equal(profitSum.verdict, 'PROFIT');

  const lossSum = vm.runInContext(`summarizeTradeSet([
    { closed: true, outcome: 'WIN_TP1', r: 0.5 },
    { closed: true, outcome: 'LOSS', r: -1.0 },
    { closed: true, outcome: 'LOSS', r: -1.0 }
  ])`, ctx);
  assert.equal(lossSum.verdict, 'LOSS');
  assert.equal(lossSum.netR, -1.5);
  assert.equal(lossSum.winRatePct, 33.3);
});

test('evaluateSignalHistory & renderSignalHistory produce multi-day backtest & live tracker stats in UI', () => {
  const { ctx, elements } = createSandbox();

  // 420 bar 5m XAU/USD: sesi tenang (ATR5m ~2.05) -> rilis 11:36Z -> impuls naik
  // ~0.75% (>= 1.5x ATR5m) -> order LIMIT di retrace 38.2% impuls (~4128)
  // DISENTUH harga dalam TTL 60 menit, lalu rally ke TP2. Rilis sengaja TIDAK
  // selaras 5m supaya bar dasar reaksi = bar pra-rilis terakhir (11:35Z).
  const baseK = Math.floor(Date.parse('2026-11-08T00:00:00Z') / 60000);
  const goldBars = [];
  let px = 4100;
  for (let i = 0; i <= 138; i++) {
    const o = px;
    const c = px + 0.05;
    goldBars.push({ k: baseK + i * 5, o, h: c + 1, l: o - 1, c });
    px = c;
  }
  goldBars.push({ k: baseK + 695, o: 4106.95, h: 4108, l: 4105.95, c: 4107 }); // bar pra-rilis
  goldBars.push({ k: baseK + 700, o: 4107, h: 4125, l: 4107, c: 4123 });       // impuls +16
  goldBars.push({ k: baseK + 705, o: 4123, h: 4139, l: 4122, c: 4137 });       // impuls +14
  goldBars.push({ k: baseK + 710, o: 4137, h: 4141, l: 4134, c: 4138 });       // puncak impuls
  goldBars.push({ k: baseK + 715, o: 4138, h: 4147, l: 4137, c: 4147 });       // bar entry (+19 mnt)
  // Order LIMIT BUY di retrace 38.2% (~4128) baru terisi bila harga MENYENTUH
  // level itu dalam TTL 60 menit (12 bar) — bukan fill instan.
  const retracePath = [4139, 4131, 4127, 4124, 4128, 4134, 4142, 4152, 4165, 4180, 4196, 4214];
  px = 4147;
  for (let j = 0; j < retracePath.length; j++) {
    const i = 144 + j, o = px, c = retracePath[j];
    goldBars.push({ k: baseK + i * 5, o, h: Math.max(o, c) + 0.6, l: Math.min(o, c) - 0.6, c });
    px = c;
  }
  for (let i = 156; i < 420; i++) {
    const o = px;
    const c = i <= 300 ? px + 1.2 : px - 0.3;
    goldBars.push({ k: baseK + i * 5, o, h: Math.max(o, c) + 1.5, l: Math.min(o, c) - 1.5, c });
    px = c;
  }

  const nowMs = (baseK + 420 * 5) * 60000;
  const evDate = new Date((baseK + 696) * 60000).toISOString(); // 11:36Z, di antara bar 11:35 & 11:40

  vm.runInContext(`
    events = [normalize({ Date: ${JSON.stringify(evDate)}, Country: 'United States', Event: 'Unemployment Claims', Importance: 3, Actual: '235K', Forecast: '195K', Previous: '194K' })];
    HISTORY_BARS = { generatedAt: new Date(${nowMs}).toISOString(), intervalMin: 5, pairs: { 'XAU/USD': ${JSON.stringify(goldBars)} } };
    LIVE_PRICE = ${px};
    localStorage.setItem(SIGNAL_HISTORY_KEY, JSON.stringify([
      { id: 't1', kind: 'gold', asset: 'XAU/USD', mode: 'POST', dir: 'long', entry: 4010, sl: 3985, tp1: 4035, tp: 4060, at: ${nowMs - 3600000}, outcome: 'WIN_TP2', closed: true, tp1Hit: true, r: 1.5 }
    ]));
    renderSignalHistory(${nowMs});
  `, ctx);

  const html = elements.get('#signalHistoryStats').innerHTML;
  assert.match(html, /Evaluasi Winrate/);
  assert.match(html, /Profit Factor/);
  assert.match(html, /Net Return \(Closed\)/);
  assert.match(html, /Gold \(XAU\/USD\)/);
  assert.match(html, /Live Browser Tracker/);

  const summary = vm.runInContext(`evaluateSignalHistory({ now: ${nowMs} })`, ctx);
  assert.equal(summary.usedHistory5d, true);
  assert.ok(summary.overall.total >= 1, 'Expected at least 1 evaluated signal from calendar/replay');
  assert.ok(summary.overall.closedCount >= 1, 'Expected closed outcomes across multi-day swing');
  assert.equal(summary.liveSummary.winsCount, 1);
  assert.equal(summary.liveSummary.verdict, 'PROFIT');
});

test('offline 60-day backtest is the headline; 5-day replay stays a separate diagnostic', () => {
  const { ctx, elements } = createSandbox();
  const offline = {
    generatedAt: '2026-11-27T03:17:00.000Z',
    windowDays: 60,
    range: '60d',
    sourceLabel: 'Backtest Yahoo 60d offline',
    overall: {
      verdict: 'PROFIT', netR: 8, closedCount: 38, openCount: 15,
      winsCount: 24, lossesCount: 14, winRatePct: 63.2,
      winRateCiLow: 47.3, winRateCiHigh: 76.6,
      profitFactor: 1.57, expectancyR: 0.21
    },
    watchSummary: { total: 75, closedCount: 75, winRatePct: 58.7, netR: 14.6 }
  };
  vm.runInContext(`
    BACKTEST_STATS = ${JSON.stringify(offline)};
    renderSignalHistory(Date.now());
  `, ctx);
  const html = elements.get('#signalHistoryStats').innerHTML;
  assert.match(html, /Headline Winrate — Backtest Yahoo 60d/);
  assert.match(html, /63\.2%/);
  assert.match(html, /CI95 47\.3–76\.6%/);
  assert.match(html, /sampel cepat 5d, bukan headline/);
  assert.match(html, /Jalur Watch/);
  assert.match(html, /Evaluasi Winrate/);
});
