import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Kalibrasi level entry ke harga eksekusi riil:
//   1. Quote broker segar  -> entry = ask (BUY) / bid (SELL), persis FBS.
//   2. Quote broker basi   -> TIDAK boleh dipakai; jatuh ke harga live ± estimasi
//      spread (spread quote basi masih relevan, level harganya tidak).
//   3. SL/TP dikalibrasi ATR 1 menit dari data/markets.json — melebar saat
//      rilis besar, tidak mengubah perilaku tenang.
const source = await readFile(new URL('../index.html', import.meta.url), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name}() not found in index.html`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Could not extract ${name}()`);
}

const clampNumFn = extractFunction('clampNum');
const marketsFreshFn = extractFunction('marketsFresh');
const barsOfFn = extractFunction('barsOf');
const assetBarsFn = extractFunction('assetBars');
const atrInfoFn = extractFunction('atrInfo');
const structureStopDistanceFn = extractFunction('structureStopDistance');
const halfSpreadEstimateFn = extractFunction('halfSpreadEstimate');
const execEntriesFn = extractFunction('execEntries');
const computeSignalLevelsFn = extractFunction('computeSignalLevels');
const spreadConst = source.match(/const DEFAULT_SPREAD_PCT = .*?;\n/)[0];
assert.ok(spreadConst, 'DEFAULT_SPREAD_PCT must stay on a single line for this test');

function buildEngine(brokerPayload, markets) {
  const body = `
    const MARKETS = ${JSON.stringify(markets)};
    const LIVE_BARS = {};
    ${spreadConst}
    ${clampNumFn}
    ${marketsFreshFn}
    ${barsOfFn}
    ${assetBarsFn}
    ${atrInfoFn}
    ${structureStopDistanceFn}
    ${halfSpreadEstimateFn}
    ${execEntriesFn}
    function brokerQuoteFor() { return ${JSON.stringify(brokerPayload)}; }
    ${computeSignalLevelsFn}
    return computeSignalLevels;
  `;
  return new Function(body)();
}

const now = Date.now();
const event = { Importance: 3 };

// 1) Broker segar: entry persis bid/ask broker.
const fresh = { bid: 1.1, ask: 1.10012, spreadPips: 1.2, stale: false, brokerName: 'FBS' };
const engineFresh = buildEngine(fresh, null);
const buyFresh = engineFresh('forex', 'EUR/USD', 'long', 1.10006, event, { movePct: 0.2 });
assert.equal(buyFresh.entry, 1.10012, 'BUY must enter at broker ask');
assert.equal(buyFresh.broker, 'FBS');
assert.equal(buyFresh.entrySource, 'broker');
const sellFresh = engineFresh('forex', 'EUR/USD', 'short', 1.10006, event, { movePct: 0.2 });
assert.equal(sellFresh.entry, 1.1, 'SELL must enter at broker bid');

// 2) Quote basi tidak boleh jadi harga entry (inilah sebabnya dulu entry tidak
//    pernah cocok dengan harga pasar): jatuh ke harga live + setengah spread.
const staleQuote = { bid: 1.05, ask: 1.05012, spreadPips: 1.2, stale: true, brokerName: 'FBS' };
const engineStale = buildEngine(staleQuote, null);
const buyStale = engineStale('forex', 'EUR/USD', 'long', 1.10006, event, { movePct: 0.2 });
assert.equal(buyStale.entry, 1.10006 + 0.00006, 'stale bid/ask is replaced by live mid + half of the quoted spread');
assert.equal(buyStale.entrySource, 'estimated');

// 3) Lantai ATR: SL mengikuti volatilitas riil saat rilis besar.
const wildBars = [];
for (let i = 0; i < 40; i++) wildBars.push({ k: i, o: 4000, h: 4020, l: 3980, c: 4000 }); // range $40 / 1m
const wildMarkets = { generatedAt: new Date(now).toISOString(), pairs: { 'XAU/USD': { bars: wildBars } } };
const engineWild = buildEngine(null, wildMarkets);
const goldWild = engineWild('gold', 'XAU/USD', 'long', 4000, event, { movePct: null });
assert.equal(goldWild.entrySource, 'estimated');
// ATR $40 dari harga 4000 = 1.0% -> lantai 1.6%, di atas pola tetap 0.715%.
assert.ok(Math.abs(goldWild.riskPct - 1.6) < 1e-9, `ATR floor must widen gold SL, got ${goldWild.riskPct}`);
const goldEntry = 4000 + 0.15; // setengah spread emas 0.0075% dari 4000
assert.ok(Math.abs(goldWild.entry - goldEntry) < 1e-9);
assert.ok(Math.abs(goldWild.sl - goldEntry * (1 - 0.016)) < 1e-6);
assert.ok(Math.abs(goldWild.tp - goldEntry * (1 + 0.032)) < 1e-6);

// 4) markets.json basi (>2 jam) -> ATR diabaikan, perilaku tetap seperti dulu.
const oldMarkets = { generatedAt: new Date(now - 3 * 60 * 60 * 1000).toISOString(), pairs: { 'XAU/USD': { bars: wildBars } } };
const engineOld = buildEngine(null, oldMarkets);
const goldCalm = engineOld('gold', 'XAU/USD', 'long', 4000, event, { movePct: null });
assert.ok(Math.abs(goldCalm.riskPct - 0.715) < 0.01, 'stale bar history must not drive the risk');

// 5) Forex: ATR 30 pips/1m + spread melebarkan SL melewati pola tetap, masih di-clamp.
const fxBars = [];
for (let i = 0; i < 40; i++) fxBars.push({ k: i, o: 1.1, h: 1.1015, l: 1.0985, c: 1.1 }); // range 30 pips / 1m
const fxMarkets = { generatedAt: new Date(now).toISOString(), pairs: { 'EUR/USD': { bars: fxBars } } };
const engineFx = buildEngine(null, fxMarkets);
const fxBuy = engineFx('forex', 'EUR/USD', 'long', 1.1, event, { movePct: 0 });
// atrPips 30 -> 30*1.2 + 1 pip spread * 1.5 = 37.5 (di antara clamp 25..45).
assert.equal(fxBuy.stopPips, 37.5);
assert.ok(Math.abs((fxBuy.entry - fxBuy.sl) - fxBuy.stopPips * 0.0001) < 1e-9);
assert.ok(Math.abs((fxBuy.tp - fxBuy.entry) - 2 * (fxBuy.entry - fxBuy.sl)) < 1e-9, 'TP stays 1:2 vs SL');

console.log('Passed 5/5 signal-level calibration tests');
