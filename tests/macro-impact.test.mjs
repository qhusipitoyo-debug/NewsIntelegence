import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function loadDataJson(name) {
  return JSON.parse(readFileSync(join(ROOT, 'data', name), 'utf8'));
}

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

  const calendar = loadDataJson('calendar.json');
  const markets = loadDataJson('markets.json');
  const forex = loadDataJson('forex.json');
  const indices = loadDataJson('indices.json');
  const crypto = loadDataJson('crypto.json');
  const gold = loadDataJson('market.json');

  ctx.__fix = { calendar, markets, forex, indices, crypto, gold };
  vm.runInContext(`
    events = __fix.calendar.map(normalize).sort((a, b) => new Date(a.Date) - new Date(b.Date));
    MARKETS = __fix.markets;
    FOREX_META = __fix.forex;
    FOREX_RATES = __fix.forex.rates || {};
    if (typeof applyForexPayload === 'function') applyForexPayload(__fix.forex);
    if (typeof applyIndexItems === 'function') applyIndexItems(__fix.indices.items || []);
    CRYPTO_RATES = (__fix.crypto && (__fix.crypto.pairs || __fix.crypto.rates)) || {};
    CRYPTO_CHANGE = (__fix.crypto && __fix.crypto.change) || {};
    INDEX_CHANGE = { US500: -0.75 };
    LIVE_PRICE = Number(__fix.gold && __fix.gold.price) || 4100;
    SENTIMENT = { score: 38, rating: 'Fear', source: 'CNN Fear & Greed' };
    SENTIMENT_CRYPTO = { score: 55, rating: 'Neutral', source: 'Alternative.me' };
  `, ctx);

  return { ctx, elements };
}

test('macro impact analysis returns one row per instrument with valid badges and drivers', () => {
  const { ctx } = createDashboardSandbox();
  const rows = vm.runInContext(`macroImpactAnalysis(Date.parse('2026-11-11T10:00:00Z'))`, ctx);
  assert.equal(rows.length, 13, 'gold + BTC + ETH + US500 + 9 forex pairs');
  for (const r of rows) {
    assert.ok(r.asset, 'asset present');
    if (r.watch) {
      assert.ok(['long', 'short', null].includes(r.watch.dir), 'direction is long/short/null for ' + r.asset);
    }
    assert.ok(r.risk && r.risk.regime, 'risk regime attached to ' + r.asset);
  }
  const withCatalyst = rows.filter(r => r.catalyst);
  assert.ok(withCatalyst.length >= 1, 'at least one instrument must have a macro catalyst in ±12h');
  const goldRow = rows.find(r => r.asset === 'XAU/USD');
  assert.ok(goldRow && goldRow.price > 0, 'gold must have a price');
});

test('renderMacroImpact paints the grid with summary chips and 13 instrument cards', () => {
  const { ctx, elements } = createDashboardSandbox();
  vm.runInContext(`renderMacroImpact()`, ctx);
  const html = elements.get('#macroImpactGrid').innerHTML;
  assert.ok(html.includes('impact-summary'), 'summary chips rendered');
  assert.ok(html.includes('BUY'), 'BUY summary rendered');
  assert.ok(html.includes('SELL'), 'SELL summary rendered');
  assert.ok(html.includes('WAIT'), 'WAIT summary rendered');
  const cards = html.match(/tech-card (buy|sell|wait)/g) || [];
  assert.equal(cards.length, 13, '13 instrument cards');
  for (const pair of ['XAU/USD', 'EUR/USD', 'USD/JPY', 'GBP/JPY', 'BTC/USD', 'US500']) {
    assert.ok(html.includes(pair), 'card for ' + pair);
  }
  // Every card either names a catalyst or states calibration is pure sentiment/macro.
  const katalis = html.match(/Katalis: /g) || [];
  const noCat = html.match(/Tanpa katalis Imp ≥ 2/g) || [];
  assert.equal(katalis.length + noCat.length, 13);
});
