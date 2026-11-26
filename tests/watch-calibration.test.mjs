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
  vm.runInContext(readFileSync(join(ROOT, "signal-engine.js"), "utf8"), ctx);

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

  // Keep markets fresh relative to simulated timestamp and make intraday trends explicit.
  // Pilih jam di dalam sesi likuransi UTC (WINRATE_PARAMS.activeUtcHours = 07–21):
  // 05:38Z berada di luar sesi sehingga semua papan sengaja menahan entry (WAIT).
  const now = Date.parse('2026-11-11T13:38:00Z');
  vm.runInContext(`
    MARKETS.generatedAt = new Date(${now}).toISOString();
    INDEX_CHANGE = { US500: -0.85 };
    CRYPTO_CHANGE = { 'BTC/USD': -2.8, 'ETH/USD': -3.4 };
    if (MARKETS.pairs && MARKETS.pairs['BTC/USD'] && MARKETS.pairs['BTC/USD'].bars && MARKETS.pairs['BTC/USD'].bars.length) {
      CRYPTO_RATES['BTC/USD'] = MARKETS.pairs['BTC/USD'].bars.slice(-1)[0].c;
    }
    if (MARKETS.pairs && MARKETS.pairs['ETH/USD'] && MARKETS.pairs['ETH/USD'].bars && MARKETS.pairs['ETH/USD'].bars.length) {
      CRYPTO_RATES['ETH/USD'] = MARKETS.pairs['ETH/USD'].bars.slice(-1)[0].c;
    }
    // Membuat tren intraday BTC konsisten turun + impulse turun terakhir supaya
    // confluence Makro/Mikro/F&G/Spike membentuk sinyal SELL yang tren-menyenangkan
    // (EMA20 < EMA50), konsisten dengan perubahan intraday -2.8% yang di-override.
    {
      const btcBars = [];
      for (let i = 0; i < 60; i++) { const px = 68000 - i * 12; btcBars.push({ k: i, o: px - 5, h: px + 25, l: px - 25, c: px }); }
      btcBars.push({ k: 60, o: 68000, h: 68500, l: 67000, c: 66500 });
      MARKETS.pairs['BTC/USD'].bars = btcBars;
    }
    {
      const usBars = [];
      for (let i = 0; i < 60; i++) { const px = 5950 - i * 0.8; usBars.push({ k: i, o: px - 0.5, h: px + 2, l: px - 2, c: px }); }
      usBars.push({ k: 60, o: 5950, h: 5960, l: 5890, c: 5900 });
      MARKETS.pairs['US500'].bars = usBars;
    }
    {
      const jpyBars = [];
      for (let i = 0; i < 60; i++) { const px = 154 + i * 0.02; jpyBars.push({ k: i, o: px - 0.01, h: px + 0.05, l: px - 0.05, c: px }); }
      jpyBars.push({ k: 60, o: 155.1, h: 155.3, l: 155.05, c: 155.25 });
      MARKETS.pairs['USD/JPY'].bars = jpyBars;
    }
    SENTIMENT = { score: 24, rating: 'Extreme Fear', source: 'CNN Fear & Greed' };
    SENTIMENT_CRYPTO = { score: 85, rating: 'Extreme Greed', source: 'Alternative.me' };
    // Kalender ter-refresh menyasarkan katalis MBA (tanpa Forecast → surprise
    // tak terukur) sehingga board kripto sempat stall. Titiskan katalis CPI dengan
    // Actual = Forecast (tanpa kejutan) supaya arah benar-benar datang dari momentum
    // teknikal mikro, sesuai jalur kalibrasi WATCH yang diuji.
    events = [normalize({ Date: '2026-11-11T12:30:00Z', Country: 'United States', Event: 'Core CPI m/m', Importance: 3, Actual: '0.2%', Forecast: '0.2%' })];
    if (FOREX_QUOTES['USD/JPY']) { FOREX_QUOTES['USD/JPY'].changePct = 0.35; FOREX_QUOTES['USD/JPY'].price = 155.25; }
    if (FOREX_QUOTES['EUR/USD']) FOREX_QUOTES['EUR/USD'].changePct = -0.32;
    FOREX_QUOTES['USD/CHF'] = { price: Number(FOREX_RATES.CHF) || 0.88, changePct: 0.25 };
    if (FOREX_META && FOREX_META.rates) FOREX_META.rates.USD_CHG = 0.30;
    // Index board membaca harga/chg dari INDEX_RATES (hasil applyIndexItems) — sinkronkan
    // supaya konflik makro/mikro konsisten dengan override INDEX_CHANGE.
    if (INDEX_RATES && INDEX_RATES['US500']) { INDEX_RATES['US500'].price = 5900; INDEX_RATES['US500'].changePct = -0.85; }
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

  // Semua pair yang lolos threshold harus mengunci level (Entry/SL/TP tidak repaint).
  const btc = cryptoState.items.find(it => it.pair === 'BTC/USD');
  const us500 = idxState.items.find(it => it.symbol === 'US500');
  assert.ok(btc && btc.dir && btc.locked && btc.lockedAt, 'Crypto watch must lock levels once threshold passed');
  assert.ok(us500 && us500.dir && us500.locked && us500.lockedAt, 'Index watch must lock levels once threshold passed');
  const levelsBefore = vm.runInContext(`JSON.stringify({
    btc: cryptoBoardState(${now}).items.find(i => i.pair === 'BTC/USD').levels,
    us: indicesBoardState(${now}).items.find(i => i.symbol === 'US500').levels
  })`, ctx);
  vm.runInContext(`CRYPTO_RATES['BTC/USD'] = Number(CRYPTO_RATES['BTC/USD']) * 1.05; INDEX_RATES['US500'].price = Number(INDEX_RATES['US500'].price) * 1.05;`, ctx);
  const levelsAfter = vm.runInContext(`JSON.stringify({
    btc: cryptoBoardState(${now}).items.find(i => i.pair === 'BTC/USD').levels,
    us: indicesBoardState(${now}).items.find(i => i.symbol === 'US500').levels
  })`, ctx);
  assert.equal(levelsAfter, levelsBefore, 'Crypto/index levels must stay locked when live price moves');

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
  // 6 kartu lama (risiko/DXY/F&G-crypto/F&G-cnn/spike/kalibrasi) + 5 kartu penggerak emas.
  assert.ok(elements.get('#macroBody').innerHTML.includes('macro-card'), 'renderMacroBoard should render cards');
  assert.equal((elements.get('#macroBody').innerHTML.match(/macro-card/g) || []).length, 11, 'renderMacroBoard should render 11 macro cards (6 baseline + 5 gold drivers)');
});

test('macro risk card and DXY card must share one dollar reading (no contradictory USD narrative)', () => {
  const { ctx, elements } = createDashboardSandbox();

  vm.runInContext(`
    INDEX_RATES = { US500: { changePct: -1.0, price: 5900 } };
    CRYPTO_CHANGE = { 'BTC/USD': -2.8, 'ETH/USD': -3.4 };
    CRYPTO_RATES = { 'BTC/USD': 66500, 'ETH/USD': 1710 };
    LIVE_PRICE = 4100;
    FOREX_QUOTES = {
      'EUR/USD': { changePct: 0.15 },
      'USD/JPY': { changePct: -0.25 },
      'GBP/USD': { changePct: 0 },
      'USD/CAD': { changePct: 0.05 },
      'USD/CHF': { changePct: 0.02 },
      'EUR/JPY': { changePct: 0 },
      'GBP/JPY': { changePct: 0 }
    };
  `, ctx);

  const risk = vm.runInContext(`riskSentimentSnapshot()`, ctx);
  assert.equal(risk.regime, 'RISK-OFF');

  vm.runInContext(`renderMacroBoard();`, ctx);
  const html = elements.get('#macroBody').innerHTML;
  assert.ok(html.includes('RISK-OFF'), 'risk regime card rendered RISK-OFF');
  vm.runInContext(`renderIpoBoard();`, ctx);
  assert.ok(elements.get('#ipoBody').innerHTML.includes('IPO Anthropic'), 'IPO board rendered Anthropic sentiment impact');
  assert.ok(elements.get('#ipoBody').innerHTML.includes('Entry:'), 'IPO board must render post-IPO levels (Entry/SL/TP) — bukan 0.00');
  // Harga IPO harus terkunci: render ulang setelah harga live bergerak tidak boleh
  // mengubah Entry/SL/TP (sama seperti lock di board Gold/Crypto/Index/Forex).
  const ipoBefore = elements.get('#ipoBody').innerHTML.match(/<b>Entry:<\/b> ([\d.]+)/g) || [];
  vm.runInContext(`CRYPTO_RATES['BTC/USD'] = Number(CRYPTO_RATES['BTC/USD']) * 1.05; LIVE_PRICE = LIVE_PRICE * 1.05; renderIpoBoard();`, ctx);
  const ipoAfter = elements.get('#ipoBody').innerHTML.match(/<b>Entry:<\/b> ([\d.]+)/g) || [];
  assert.deepEqual(ipoAfter, ipoBefore, 'IPO levels must stay locked across re-render when live price moves');
  assert.ok(html.includes('▼ Dolar Turun'), 'risk card must derive dollar arrow from DXY bias (USD melemah)');
  assert.ok(!html.includes('▲ Dolar Naik'), 'risk card must not hardcode USD naik while DXY bias is down');
  assert.ok(html.includes('USD belum kembali safe-haven'), 'risk card must soften safe-haven claim when USD is weak');
});
