import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function createTestSandbox() {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'inline <script> block must exist');

  const elements = new Map();
  const dummyEl = {
    addEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    style: {},
    classList: { add: () => {}, remove: () => {} },
    offsetWidth: 100
  };
  const makeEl = (id) => ({
    id,
    innerHTML: '',
    textContent: '',
    style: {},
    classList: { add: () => {}, remove: () => {} },
    querySelectorAll: () => []
  });
  elements.set('#ipoBody', makeEl('ipoBody'));
  elements.set('#macroBody', makeEl('macroBody'));
  elements.set('#forecastGrid', makeEl('forecastGrid'));

  const sandbox = {
    document: {
      getElementById: (id) => elements.get('#' + id) || dummyEl,
      querySelector: (sel) => elements.get(sel) || dummyEl,
      querySelectorAll: (sel) => {
        const el = elements.get(sel);
        return el ? [el] : [];
      }
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {}
    },
    fetch: () => Promise.reject(new Error('offline')),
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setInterval: () => {},
    clearInterval: () => {},
    setTimeout: () => {},
    Date,
    Intl,
    Math,
    JSON,
    Number,
    String,
    Object,
    Array,
    Promise,
    encodeURIComponent
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(match[1], ctx);
  return { ctx, elements };
}

test('IPO Anthropic: XAU/USD exhibits correct Safe-Haven inverse correlation to Risk-On / Risk-Off', () => {
  const { ctx, elements } = createTestSandbox();

  // 1. RISK-ON Scenario: Index & Crypto Rally -> Gold is pressured / sell
  vm.runInContext(`
    riskSentimentSnapshot = () => ({ regime: 'RISK-ON', score: 0.8, avgPct: 0.45 });
    effectiveFearGreed = () => ({ primaryScore: 82, label: 'Extreme Greed' });
    usdBias = () => ({ changePct: -0.12 });
    renderIpoBoard();
  `, ctx);
  const ipoHtmlOn = elements.get('#ipoBody').innerHTML;
  assert.ok(ipoHtmlOn.includes('US500 (Index) · Dampak IPO'), 'US500 card rendered');
  assert.ok(ipoHtmlOn.includes('XAU/USD (Gold) · Dampak IPO'), 'Gold card rendered');
  // US500 must be BUY during Risk-On IPO euphoria
  assert.match(ipoHtmlOn, /US500[\s\S]*?big buy[\s\S]*?BUY/);
  // Gold must be SELL / FADE (rotation out of safe havens into risk assets)
  assert.match(ipoHtmlOn, /XAU\/USD[\s\S]*?big sell[\s\S]*?SELL/);

  // 2. RISK-OFF Scenario: Stocks crash -> Safe Haven Gold is BOUGHT
  vm.runInContext(`
    riskSentimentSnapshot = () => ({ regime: 'RISK-OFF', score: -0.85, avgPct: -0.52 });
    effectiveFearGreed = () => ({ primaryScore: 18, label: 'Extreme Fear' });
    usdBias = () => ({ changePct: 0.15 });
    // Reset locks for clean test
    WATCH_LOCKS = {};
    renderIpoBoard();
  `, ctx);
  const ipoHtmlOff = elements.get('#ipoBody').innerHTML;
  assert.match(ipoHtmlOff, /US500[\s\S]*?big sell[\s\S]*?SELL/);
  assert.match(ipoHtmlOff, /XAU\/USD[\s\S]*?big buy[\s\S]*?BUY/);
});

test('HTF Direction: RSI in strong trends acts as trend continuation, not contrarian sell', () => {
  const { ctx } = createTestSandbox();

  // Bull trend: EMA fast > slow, RSI in bullish zone (60-75)
  const rows = [];
  for (let i = 0; i < 45; i++) {
    const d = new Date(Date.UTC(2026, 0, 1 + i));
    const t = d.toISOString().slice(0, 10);
    const c = 2500 + i * 12;
    rows.push({ t, o: c - 5, h: c + 15, l: c - 5, c });
  }

  const res = vm.runInContext(`
    htfDirection(${JSON.stringify(rows)}, 'daily', ${rows[rows.length - 1].c});
  `, ctx);

  assert.equal(res.dir, 'buy', 'Strong uptrend with RSI in bull zone must vote BUY');
  assert.ok(res.notes.some(n => n.includes('bullish zone') || n.includes('EMA')), 'Notes must reflect bullish continuation');
});

test('HTF Alignment: Triple aligned (D/W/M) and Swing aligned (D/W with neutral M) are valid', () => {
  const { ctx } = createTestSandbox();

  // Case 1: Triple Aligned D/W/M
  const tripleBuy = vm.runInContext(`
    finalHtfAlignment({ dir: 'buy' }, { dir: 'buy' }, { dir: 'buy' }, null);
  `, ctx);
  assert.equal(tripleBuy.dir, 'buy');
  assert.match(tripleBuy.reason, /D\/W\/M aligned BUY/);

  // Case 2: Swing Aligned D/W with Monthly Neutral (WAIT)
  const swingBuy = vm.runInContext(`
    finalHtfAlignment({ dir: 'buy' }, { dir: 'buy' }, { dir: 'wait' }, null);
  `, ctx);
  assert.equal(swingBuy.dir, 'buy', 'D/W aligned with neutral Monthly must produce valid BUY');
  assert.match(swingBuy.reason, /D\/W aligned BUY/);

  // Case 3: Counter-trend conflict (D/W Buy vs Monthly Sell) -> Blocked for safety
  const conflict = vm.runInContext(`
    finalHtfAlignment({ dir: 'buy' }, { dir: 'buy' }, { dir: 'sell' }, null);
  `, ctx);
  assert.equal(conflict.dir, null, 'Counter-trend against Monthly must be WAIT');
  assert.match(conflict.reason, /Konflik HTF/);
});

test('Macro Veto: Blocks Gold BUY when Real Yield surges and DXY rallies', () => {
  const { ctx } = createTestSandbox();

  vm.runInContext(`
    SENTIMENT_CACHE = {
      drivers: {
        yield: { tenYr: 4.85, realTenYr: 2.45, zReal: 1.82, zNominal: 1.65 }
      },
      goldDrivers: { score: -45, label: 'Bearish Kuat' }
    };
    usdBias = () => ({ changePct: 0.35 });
    technicalView = () => ({ emaFast: 2600, emaSlow: 2550, price: 2610, dir: 'buy', trendText: 'tren naik' });

    const vetoRes = applyMarketContext({
      phase: 'post',
      dir: 'long',
      basis: 'actual',
      conf: 75
    }, 'gold', 'XAU/USD', Date.parse('2026-11-11T14:00:00Z'));
  `, ctx);

  const vetoRes = vm.runInContext('vetoRes', ctx);
  assert.equal(vetoRes.dir, null, 'Gold BUY must be vetoed by surging real yield + strong dollar');
  assert.equal(vetoRes.blocked, true);
  assert.equal(vetoRes.basis, 'macro-veto');
  assert.match(vetoRes.note, /Makro Veto/);
});

test('Calibrated Watch Signal integrates Yield into macroScore for Gold and Indices', () => {
  const { ctx } = createTestSandbox();

  vm.runInContext(`
    SENTIMENT_CACHE = {
      drivers: {
        yield: { tenYr: 4.90, realTenYr: 2.50, zReal: 1.6, zNominal: 1.5 }
      },
      goldDrivers: { score: -35, label: 'Bearish' }
    };
    usdBias = () => ({ changePct: 0.10 });
    assetPrice = () => 2650;
    assetBars = () => [];

    const goldSnap = calibratedWatchSignal({
      kind: 'gold',
      asset: 'XAU/USD',
      now: Date.parse('2026-11-11T14:00:00Z'),
      price: 2650,
      scoreOnly: true
    });
  `, ctx);

  const goldSnap = vm.runInContext('goldSnap', ctx);
  assert.ok(goldSnap.factors.some(f => f.includes('Real Yield')), 'Yield must be present in factors');
  assert.ok(goldSnap.factors.some(f => f.includes('Driver Emas')), 'Gold drivers must be present in factors');
  assert.ok(goldSnap.netScore < 0, 'High real yield must push Gold net score into negative/bearish territory');
});
