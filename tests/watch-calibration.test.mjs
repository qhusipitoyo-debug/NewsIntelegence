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
    Math,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
    JSON,
    RegExp,
    Error,
    Promise,
    Intl,
    encodeURIComponent,
    decodeURIComponent,
    isFinite: Number.isFinite,
    isNaN: Number.isNaN,
    setTimeout: noop,
    clearTimeout: noop,
    setInterval: () => 1,
    clearInterval: noop,
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

  function loadRealFixtures() {
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
      LIVE_PRICE = Number(__fix.gold && __fix.gold.price) || 4100;
      SENTIMENT = { score: 42, rating: 'Fear', source: 'CNN Fear & Greed' };
      SENTIMENT_CRYPTO = { score: 61, rating: 'Greed', source: 'Alternative.me' };
    `, ctx);
  }

  return { ctx, elements, store, loadRealFixtures };
}

test('detectPriceSpike classifies calm, impulse up/down, and fakeout faded spikes', () => {
  const { ctx } = createDashboardSandbox();

  // Calm bars: ~0.04% 1m range
  const calm = [];
  for (let i = 0; i < 40; i++) {
    calm.push({ k: i, o: 100, h: 100.02, l: 99.98, c: 100 });
  }
  const calmRes = vm.runInContext(`detectPriceSpike(${JSON.stringify(calm)}, 100.01)`, ctx);
  assert.equal(calmRes.state, 'NONE');

  // Impulse up: strong closing near top of candle
  const spikeUpBars = calm.concat([
    { k: 40, o: 100.0, h: 100.38, l: 100.0, c: 100.36 }
  ]);
  const upRes = vm.runInContext(`detectPriceSpike(${JSON.stringify(spikeUpBars)}, 100.36)`, ctx);
  assert.equal(upRes.state, 'SPIKE_UP');
  assert.equal(upRes.dir, 'long');
  assert.ok(upRes.spikeZ >= 2.2);

  // Impulse down
  const spikeDnBars = calm.concat([
    { k: 40, o: 100.0, h: 100.0, l: 99.60, c: 99.62 }
  ]);
  const dnRes = vm.runInContext(`detectPriceSpike(${JSON.stringify(spikeDnBars)}, 99.62)`, ctx);
  assert.equal(dnRes.state, 'SPIKE_DOWN');
  assert.equal(dnRes.dir, 'short');

  // Fakeout faded upward spike: pushed up +0.40 then wicked/closed back near open
  const fadedBars = calm.concat([
    { k: 40, o: 100.0, h: 100.42, l: 99.98, c: 100.04 }
  ]);
  const fadeRes = vm.runInContext(`detectPriceSpike(${JSON.stringify(fadedBars)}, 100.02)`, ctx);
  assert.equal(fadeRes.state, 'SPIKE_FADED');
  assert.equal(fadeRes.fadedDir, 'long');
  assert.ok(fadeRes.fadeRatio >= 0.55);
});

test('recentMacroRegime detects Nov 10 US CPI/Core CPI hawkish regime from data/calendar.json', () => {
  const { ctx, loadRealFixtures } = createDashboardSandbox();
  loadRealFixtures();

  const nov11Ms = Date.parse('2026-11-11T10:00:00Z');
  const regime = vm.runInContext(`recentMacroRegime(['USD'], ${nov11Ms})`, ctx);
  assert.ok(regime, 'expected an active USD macro regime on Nov 11');
  assert.equal(regime.country, 'USD');
  assert.ok(regime.z > 0, `expected hawkish USD z > 0 from CPI/Core CPI beat, got ${regime.z}`);
});

test('riskSentimentSnapshot classifies RISK-ON and RISK-OFF accurately', () => {
  const { ctx } = createDashboardSandbox();

  vm.runInContext(`
    INDEX_CHANGE = { NAS100: 1.15, US500: 0.75 };
    CRYPTO_CHANGE = { 'BTC/USD': 2.4 };
    LIVE_PRICE_CHANGE_PCT = -0.4;
  `, ctx);
  const riskOn = vm.runInContext(`riskSentimentSnapshot()`, ctx);
  assert.equal(riskOn.regime, 'RISK-ON');

  vm.runInContext(`
    INDEX_CHANGE = { NAS100: -1.35, US500: -0.95 };
    CRYPTO_CHANGE = { 'BTC/USD': -3.1 };
    LIVE_PRICE_CHANGE_PCT = 0.9;
  `, ctx);
  const riskOff = vm.runInContext(`riskSentimentSnapshot()`, ctx);
  assert.equal(riskOff.regime, 'RISK-OFF');
});

test('calibratedWatchSignal handles live 15m settle, imminent high-impact hold, aligned signal, fakeout rejection, and neutral WAIT', () => {
  const { ctx } = createDashboardSandbox();

  const baseBars = [];
  for (let i = 0; i < 60; i++) {
    const px = 68000 + i * 12;
    baseBars.push({ k: i, o: px - 5, h: px + 25, l: px - 25, c: px });
  }
  const bullSpikeBars = baseBars.concat([
    { k: 60, o: 68720, h: 69150, l: 68710, c: 69120 }
  ]);
  const fadedBullBars = baseBars.concat([
    { k: 60, o: 68720, h: 69180, l: 68700, c: 68760 }
  ]);

  const now = Date.parse('2026-11-11T12:00:00Z');

  // 1) Live 15m settle hold
  const liveSig = vm.runInContext(`calibratedWatchSignal({
    kind: 'crypto', asset: 'BTC/USD',
    event: { Date: new Date(${now - 5 * 60000}).toISOString(), Event: 'CPI m/m', Importance: 3, Country: 'United States' },
    now: ${now}, price: 69120, changePct: 2.5, bars: ${JSON.stringify(bullSpikeBars)},
    fg: 64, cryptoFg: 68, usdChgPct: -0.35, riskRegime: { regime: 'RISK-ON', score: 1 }
  })`, ctx);
  assert.equal(liveSig.dir, null);
  assert.equal(liveSig.basis, 'settling');

  // 2) <15m imminent High-Impact hold
  const imminentSig = vm.runInContext(`calibratedWatchSignal({
    kind: 'forex', asset: 'EUR/USD',
    event: { Date: new Date(${now + 10 * 60000}).toISOString(), Event: 'CPI m/m', Importance: 3, Country: 'United States' },
    now: ${now}, price: 1.085, bars: ${JSON.stringify(baseBars.map(b => ({ k: b.k, o: 1.085, h: 1.0852, l: 1.0848, c: 1.085 })))}
  })`, ctx);
  assert.equal(imminentSig.dir, null);
  assert.equal(imminentSig.basis, 'imminent-high');

  // 3) Aligned Macro + Micro + F&G + Risk-On produces BUY across Crypto / Index / Forex / Gold
  const cryptoBuy = vm.runInContext(`calibratedWatchSignal({
    kind: 'crypto', asset: 'BTC/USD', event: null,
    now: ${now}, price: 69120, changePct: 2.5, bars: ${JSON.stringify(bullSpikeBars)},
    fg: 64, cryptoFg: 68, usdChgPct: -0.35,
    riskRegime: { regime: 'RISK-ON', score: 1 },
    macroRegime: { country: 'USD', z: -1.4, dir: 'long', weight: 1, event: { Event: 'CPI m/m' } }
  })`, ctx);
  assert.equal(cryptoBuy.dir, 'long');
  assert.ok(cryptoBuy.conf >= 52);
  assert.ok(cryptoBuy.factors.length >= 3);

  // 4) Fakeout rejection when candidate direction matches faded spike direction
  const fakeout = vm.runInContext(`calibratedWatchSignal({
    kind: 'crypto', asset: 'BTC/USD', event: null,
    now: ${now}, price: 68760, changePct: 1.4, bars: ${JSON.stringify(fadedBullBars)},
    fg: 64, cryptoFg: 68, usdChgPct: -0.30,
    riskRegime: { regime: 'RISK-ON', score: 1 },
    macroRegime: { country: 'USD', z: -1.2, dir: 'long', weight: 1, event: { Event: 'CPI m/m' } }
  })`, ctx);
  assert.equal(fakeout.dir, null);
  assert.equal(fakeout.modeLabel, 'FAKEOUT');

  // 5) Neutral / conflicting factors stay WAIT cleanly
  const calmFlat = [];
  for (let i = 0; i < 40; i++) calmFlat.push({ k: i, o: 100, h: 100.01, l: 99.99, c: 100 });
  const neutral = vm.runInContext(`calibratedWatchSignal({
    kind: 'index', asset: 'NAS100', event: null,
    now: ${now}, price: 100, changePct: 0.05, bars: ${JSON.stringify(calmFlat)},
    fg: 50, cryptoFg: 50, usdChgPct: 0.01,
    riskRegime: { regime: 'MIXED', score: 0 },
    macroRegime: null
  })`, ctx);
  assert.equal(neutral.dir, null);
  assert.equal(neutral.modeLabel, 'WAIT');
});

test('End-to-end watch boards and HTML render cleanly on real data/* fixtures', () => {
  const { ctx, elements, loadRealFixtures } = createDashboardSandbox();
  loadRealFixtures();

  // Keep markets fresh relative to simulated timestamp and make intraday trends explicit
  const now = Date.parse('2026-11-11T05:38:00Z');
  vm.runInContext(`
    MARKETS.generatedAt = new Date(${now}).toISOString();
    INDEX_CHANGE = { NAS100: -1.2, US500: -0.85 };
    CRYPTO_CHANGE = { 'BTC/USD': -2.8, 'ETH/USD': -3.4 };
    SENTIMENT = { score: 24, rating: 'Extreme Fear', source: 'CNN Fear & Greed' };
    SENTIMENT_CRYPTO = { score: 28, rating: 'Fear', source: 'Alternative.me' };
    if (FOREX_QUOTES['USD/JPY']) FOREX_QUOTES['USD/JPY'].changePct = 0.35;
    if (FOREX_QUOTES['EUR/USD']) FOREX_QUOTES['EUR/USD'].changePct = -0.32;
    FOREX_QUOTES['USD/CHF'] = { price: Number(FOREX_RATES.CHF) || 0.88, changePct: 0.25 };
    if (FOREX_META && FOREX_META.rates) FOREX_META.rates.USD_CHG = 0.30;
  `, ctx);

  const goldState = vm.runInContext(`goldBoardState(${now})`, ctx);
  const cryptoState = vm.runInContext(`cryptoBoardState(${now})`, ctx);
  const forexState = vm.runInContext(`forexBoardState(${now})`, ctx);
  const idxState = vm.runInContext(`indicesBoardState(${now})`, ctx);

  assert.ok(['pre', 'post', 'watch'].includes(goldState.status));
  assert.ok(cryptoState.items.some(it => it.dir === 'long' || it.dir === 'short'),
    'Crypto watch should calibrate directional signal instead of stalling on WAIT');
  assert.ok(idxState.items.some(it => it.dir === 'long' || it.dir === 'short'),
    'Index watch should calibrate directional signal instead of stalling on WAIT');
  assert.ok(forexState.items.some(it => it.dir === 'long' || it.dir === 'short'),
    'Forex watch should calibrate directional signal instead of stalling on WAIT');

  const goldHtml = vm.runInContext(`goldBoardHtml(LIVE_PRICE, goldBoardState(${now}))`, ctx);
  const cryptoHtml = vm.runInContext(`cryptoBoardHtml(CRYPTO_RATES, CRYPTO_CHANGE, cryptoBoardState(${now}))`, ctx);
  const forexHtml = vm.runInContext(`forexBoardHtml(forexBoardState(${now}))`, ctx);
  const idxHtml = vm.runInContext(`indicesBoardHtml(indicesBoardState(${now}))`, ctx);

  assert.match(goldHtml, /Entry/);
  assert.match(cryptoHtml, /(BUY|SELL)/);
  assert.match(cryptoHtml, /watch-factors/);
  assert.match(forexHtml, /(BUY|SELL)/);
  assert.match(idxHtml, /(BUY|SELL)/);
  assert.match(idxHtml, /conf-pill/);

  vm.runInContext(`renderTechBoard(); renderMacroBoard();`, ctx);
  assert.ok(elements.get('#techGrid').innerHTML.includes('tech-card'), 'renderTechBoard should render cards');
  assert.ok(elements.get('#macroBody').innerHTML.includes('macro-card'), 'renderMacroBoard should render 6 macro cards');
});
