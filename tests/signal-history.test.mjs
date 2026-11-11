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

  // Construct 500 x 5m bars for XAU/USD with clear macro regime + sustained rally hitting TP2
  const baseK = Math.floor(Date.parse('2026-11-08T00:00:00Z') / 60000);
  const goldBars = [];
  let px = 4000;
  for (let i = 0; i < 420; i++) {
    const step = i < 70 ? 0.15 : (i < 220 ? 0.95 : -0.65);
    const o = px;
    const c = px + step;
    const h = Math.max(o, c) + 0.6;
    const l = Math.min(o, c) - 0.5;
    goldBars.push({ k: baseK + i * 5, o, h, l, c });
    px = c;
  }

  const nowMs = (baseK + 420 * 5) * 60000;
  const evDate = new Date((baseK + 55 * 5) * 60000).toISOString();

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
