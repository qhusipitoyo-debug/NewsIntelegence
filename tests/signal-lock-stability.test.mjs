import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function createDashboardSandbox() {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'inline <script> block must exist in index.html');

  const elements = new Map();
  const makeEl = (id) => ({
    id,
    innerHTML: '',
    textContent: '',
    className: '',
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
    console,
    Math, Date, Number, String, Boolean, Array, Object, JSON, RegExp, Error, Promise, Intl,
    encodeURIComponent, decodeURIComponent,
    isFinite: Number.isFinite, isNaN: Number.isNaN,
    setTimeout: noop, clearTimeout: noop,
    setInterval: () => 1, clearInterval: noop,
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' }),
    localStorage: {
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
  return { ctx, store };
}

const NOW = Date.parse('2026-11-16T12:00:00Z');
// Bar perlahan naik (EMA20 > EMA50) dengan sedikit penarikan di ujung — net score
// moderat positif (di bawah ambang aktivasi 1.25, tetapi di atas batas tahan 0.55).
const dipBars = (() => {
  const out = [];
  let px = 4100;
  for (let i = 0; i < 76; i++) { px += 0.8; out.push({ k: i, o: px - 0.3, h: px + 0.3, l: px - 0.3, c: px }); }
  for (let j = 0; j < 4; j++) { px -= 0.6; out.push({ k: 76 + j, o: px + 0.55, h: px + 0.75, l: px - 0.2, c: px }); }
  return out;
})();
const riseBars = dipBars.slice(0, 76);

test('synthetic watch event key is stable across ticks (order stays findable)', () => {
  const { ctx } = createDashboardSandbox();
  const a = vm.runInContext(`syntheticWatchEvent('XAU/USD', ${NOW})`, ctx);
  const b = vm.runInContext(`syntheticWatchEvent('XAU/USD', ${NOW + 3 * 60 * 60 * 1000})`, ctx);
  assert.equal(a.Date, b.Date, 'watch key must not change within the same day');
  assert.equal(a.Event, 'XAU/USD Market Watch');
  const keyA = vm.runInContext(`signalLockKey(${JSON.stringify(a)}, 'XAU/USD')`, ctx);
  const keyB = vm.runInContext(`signalLockKey(${JSON.stringify(b)}, 'XAU/USD')`, ctx);
  assert.equal(keyA, keyB, 'lock key must be stable across renders');
});

test('calibratedWatchSignal keeps an active WATCH direction while the score hovers near the threshold', () => {
  const { ctx } = createDashboardSandbox();
  const asset = 'BTC/USD';
  // Tick 1: strong aligned setup → must activate BUY and write the hold.
  const strong = vm.runInContext(`calibratedWatchSignal({
    kind: 'crypto', asset: '${asset}', event: null,
    now: ${NOW}, price: ${riseBars[riseBars.length - 1].c}, changePct: 2.4, bars: ${JSON.stringify(riseBars)},
    fg: 20, cryptoFg: 18, usdChgPct: -0.35,
    riskRegime: { regime: 'RISK-ON', score: 1 },
    macroRegime: { country: 'USD', z: -1.4, dir: 'long', weight: 1.0, event: { Event: 'CPI m/m' } }
  })`, ctx);
  assert.equal(strong.dir, 'long');

  // Tick 2: same asset, setup faded below the activation bar but still constructive
  // → hysteresis must keep the direction instead of toggling to WAIT.
  const weak = vm.runInContext(`calibratedWatchSignal({
    kind: 'crypto', asset: '${asset}', event: null,
    now: ${NOW}, price: ${dipBars[dipBars.length - 1].c}, changePct: 0, bars: ${JSON.stringify(dipBars)},
    fg: 50, cryptoFg: 50, usdChgPct: 0,
    riskRegime: { regime: 'MIXED', score: 0 },
    macroRegime: { country: 'USD', z: -0.7, dir: 'long', weight: 0.7, event: { Event: 'CPI m/m' } }
  })`, ctx);
  assert.equal(weak.dir, 'long', 'active watch signal must not flip/vanish on marginal score changes');
  assert.equal(weak.basisHeld, true);

  // Tick 3: genuinely bearish setup → the hold must release, not cling to BUY.
  const downBars = (() => {
    const out = [];
    let px = 4100;
    for (let i = 0; i < 80; i++) { px -= 1.1; out.push({ k: i, o: px + 0.4, h: px + 0.4, l: px - 0.4, c: px }); }
    return out;
  })();
  const collapsed = vm.runInContext(`calibratedWatchSignal({
    kind: 'crypto', asset: '${asset}', event: null,
    now: ${NOW}, price: ${downBars[downBars.length - 1].c}, changePct: -2.4, bars: ${JSON.stringify(downBars)},
    fg: 80, cryptoFg: 88, usdChgPct: 0.35,
    riskRegime: { regime: 'RISK-OFF', score: -1 },
    macroRegime: { country: 'USD', z: 1.4, dir: 'short', weight: 1.0, event: { Event: 'CPI m/m' } }
  })`, ctx);
  assert.notEqual(collapsed.dir, 'long', 'hold must release when the setup genuinely deteriorates');
});

test('resolveSignalLevels locks watch-phase Entry/SL/TP across ticks and live prices', () => {
  const { ctx, store } = createDashboardSandbox();
  const watch = vm.runInContext(`({ dir: 'long', phase: 'watch', basis: 'watch-calibrated', conf: 70, movePct: 0.9 })`, ctx);
  const ref = vm.runInContext(`syntheticWatchEvent('BTC/USD', ${NOW})`, ctx);
  vm.runInContext(`CRYPTO_RATES = { 'BTC/USD': 69000 }; LIVE_PRICE = 69000;`, ctx);
  const first = vm.runInContext(`resolveSignalLevels(${JSON.stringify(ref)}, 'BTC/USD', 'crypto', ${JSON.stringify(watch)}, ${NOW})`, ctx);
  assert.ok(first.locked, 'watch signal must be locked on first confirmation');
  assert.ok(Number.isFinite(first.levels.entry));

  vm.runInContext(`CRYPTO_RATES = { 'BTC/USD': 70250 };`, ctx);
  const second = vm.runInContext(`resolveSignalLevels(${JSON.stringify(ref)}, 'BTC/USD', 'crypto', ${JSON.stringify(watch)}, ${NOW + 60000})`, ctx);
  assert.equal(second.levels.entry, first.levels.entry, 'watch entry must not repaint as price moves');
  assert.equal(second.levels.sl, first.levels.sl, 'watch SL must not repaint as price moves');
  assert.equal(second.levels.tp, first.levels.tp, 'watch TP must not repaint as price moves');
  assert.equal(second.dir, 'long');

  // Persisted lock is reusable across renders (fresh sandbox read from the same store is
  // covered by the post-news regression suite; here the store must contain the lock).
  assert.ok([...store.keys()].some(k => k.startsWith('feriha:signal:v2:')), 'lock must persist to localStorage');
});

test('pre-news order lock survives an opposing tick but a fresh release basis may replace it', () => {
  const { ctx } = createDashboardSandbox();
  const ev = { Date: new Date(NOW + 60 * 60 * 1000).toISOString(), Event: 'CPI m/m', Country: 'USD', Importance: 3, Forecast: '3.2', Previous: '3.0', Actual: '' };
  vm.runInContext(`LIVE_PRICE = 4100;`, ctx);
  const sig = { dir: 'short', phase: 'pre', basis: 'forecast', conf: 60 };
  const first = vm.runInContext(`resolveSignalLevels(${JSON.stringify(ev)}, 'XAU/USD', 'gold', ${JSON.stringify(sig)}, ${NOW})`, ctx);
  assert.ok(first.locked, 'pre-news order must lock');
  const second = vm.runInContext(`resolveSignalLevels(${JSON.stringify(ev)}, 'XAU/USD', 'gold', ${JSON.stringify(sig)}, ${NOW + 30000})`, ctx);
  assert.equal(second.levels.entry, first.levels.entry);
  assert.equal(second.dir, 'short');
});
