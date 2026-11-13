import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sentimentOverlay } from '../scripts/xauusd-signal-rules.js';

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

const core = source.slice(source.indexOf('// BEGIN CALIBRATION CORE'), source.indexOf('// END CALIBRATION CORE'));
const numFn = extractFunction('num');
const countryFn = extractFunction('countryCode');
const biasFn = extractFunction('goldBias');
const analyzeFn = extractFunction('analyze');
const analyze = new Function(`${core}\n${numFn}\n${countryFn}\n${biasFn}\n${analyzeFn}\nreturn analyze;`)();

const cases = [
  [{Event:'Nonfarm Payrolls', Actual:150000, Forecast:200000}, 'long'],
  [{Event:'Nonfarm Payrolls', Actual:250000, Forecast:200000}, 'short'],
  [{Event:'Unemployment Rate', Actual:4.2, Forecast:4.0}, 'long'],
  [{Event:'Unemployment Rate', Actual:3.8, Forecast:4.0}, 'short'],
  [{Event:'Initial Jobless Claims', Actual:230000, Forecast:220000}, 'long'],
  [{Event:'Initial Jobless Claims', Actual:210000, Forecast:220000}, 'short'],
  [{Event:'CPI', Actual:2.8, Forecast:3.0}, 'long'],
  [{Event:'CPI', Actual:3.2, Forecast:3.0}, 'short'],
  [{Event:'Unknown Indicator', Actual:10, Forecast:9}, 'wait'],
  [{Event:'CPI', Actual:null, Forecast:3.0}, 'wait'],
];

for (const [input, expected] of cases) {
  assert.equal(analyze(input).dir, expected, JSON.stringify(input));
}

console.log(`Passed ${cases.length}/${cases.length} actual index.html signal tests`);

// Post-news regression: momentum is calculated per pair (not gold for every pair).
const tpSlFn = extractFunction('tpSl');
const pairRateFromFn = extractFunction('pairRateFrom');
const pairRateFn = extractFunction('pairRate');
const newsPhaseFn = extractFunction('newsPhase');
const momentumForFn = extractFunction('momentumFor');
const postNewsMomentumFn = extractFunction('postNewsMomentum');
const eventAssetsFn = extractFunction('eventAssets');
const pairCurrenciesFn = extractFunction('pairCurrencies');
const focusPairFn = extractFunction('focusPair');
const normalizeSnapshotFn = extractFunction('normalizeSnapshot');
const preNewsSnapshotFn = extractFunction('preNewsSnapshot');
const preNewsPriceFn = extractFunction('preNewsPrice');
const eventKeyFn = extractFunction('eventKey');
const dateEventKeyFn = extractFunction('dateEventKey');
const postNewsExpiryFn = extractFunction('postNewsExpiry');
const forecastBiasFn = extractFunction('forecastBias');
const preNewsBiasFn = extractFunction('preNewsBias');
const invertDirFn = extractFunction('invertDir');
const mapPairBiasFn = extractFunction('mapPairBias');
const indexRateFn = extractFunction('indexRate');
const barsOfFn = extractFunction('barsOf');
const barBaseBeforeFn = extractFunction('barBaseBefore');
const reactionFromBarsClientFn = extractFunction('reactionFromBarsClient');
const preReleaseAtrPctFn = extractFunction('preReleaseAtrPct');
const reactionForFn = extractFunction('reactionFor');
const moveNoteFn = extractFunction('moveNote');
const nextPairCatalystFn = extractFunction('nextPairCatalyst');
const pairCatalystDirectionFn = extractFunction('pairCatalystDirection');
const momentumFloorFn = extractFunction('momentumFloor');
const reactionFloorFn = extractFunction('reactionFloor');
const mapAssetBiasFn = extractFunction('mapAssetBias');
const mapActualBiasFn = extractFunction('mapActualBias');
const signalDirectionCoreFn = extractFunction('signalDirectionCore');
const applyMarketContextFn = extractFunction('applyMarketContext');
const signalDirectionFn = extractFunction('signalDirection');
const signalLockKeyFn = extractFunction('signalLockKey');
const readSignalLockFn = extractFunction('readSignalLock');
const writeSignalLockFn = extractFunction('writeSignalLock');
const assetPriceFn = extractFunction('assetPrice');
const clampNumFn = extractFunction('clampNum');
const marketsFreshFn = extractFunction('marketsFresh');
const assetBarsFn = extractFunction('assetBars');
const atrInfoFn = extractFunction('atrInfo');
const structureStopDistanceFn = extractFunction('structureStopDistance');
const halfSpreadEstimateFn = extractFunction('halfSpreadEstimate');
const execEntriesFn = extractFunction('execEntries');
const spreadConst = source.match(/const DEFAULT_SPREAD_PCT = .*?;\n/)[0];
const computeSignalLevelsFn = extractFunction('computeSignalLevels');
const levelsFromLockFn = extractFunction('levelsFromLock');
const missedFromLevelsFn = extractFunction('missedFromLevels');
const resolveSignalLevelsFn = extractFunction('resolveSignalLevels');
const signalCardDataFn = extractFunction('signalCardData');
const riskSensitiveConst = source.match(/const RISK_SENSITIVE_EVENT = .*?;\n/)[0];
const rateDrivenConst = source.match(/const RATE_DRIVEN_EVENT = .*?;\n/)[0];

function buildTpSl(livePrice, forexRates, cryptoRates, store, preNews = {}, indexRates = defaultIndexRates, reaction = null) {
  const body = `
    const WITA = 'Asia/Makassar';
    const POST_NEWS_HOLD_MS = 6 * 60 * 60 * 1000;
    const NEWS_SETTLE_MS = 15 * 60 * 1000;
    const MOMENTUM_WINDOW_MS = 90 * 60 * 1000;
    const SIGNAL_LOCK_PREFIX = 'feriha:signal:v2:';
    ${riskSensitiveConst}
    ${rateDrivenConst}
    const FOREX_MAJORS = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'AUD/USD', 'USD/CAD', 'NZD/USD'];
    const FOREX_CROSSES = ['GBP/JPY', 'EUR/JPY'];
    const FOREX_PAIRS = [...FOREX_MAJORS, ...FOREX_CROSSES];
    const INDICES = [
      { symbol: 'US500', name: 'S&P 500', yahoo: '^GSPC', slPct: 0.75, tpPct: 1.5 }
    ];
    const fmtDate = d => new Intl.DateTimeFormat('en-IN', { timeZone: WITA, weekday: 'short', day: '2-digit', month: 'short' }).format(d);
    const fmtTime = d => new Intl.DateTimeFormat('en-IN', { timeZone: WITA, hour: '2-digit', minute: '2-digit', hour12: false }).format(d) + ' WITA';
    const esc = s => String(s ?? '');
    const REACTION_MAX_AGE_MS = 45 * 60 * 1000;
    const REACTION = ${JSON.stringify(reaction)};
    ${numFn}
    ${countryFn}
    ${biasFn}
    ${analyzeFn}
    ${normalizeSnapshotFn}
    ${dateEventKeyFn}
    ${eventKeyFn}
    ${preNewsSnapshotFn}
    ${preNewsPriceFn}
    ${newsPhaseFn}
    ${pairRateFromFn}
    ${pairRateFn}
    ${indexRateFn}
    ${moveNoteFn}
    ${barsOfFn}
    ${barBaseBeforeFn}
    ${reactionFromBarsClientFn}
    ${preReleaseAtrPctFn}
    ${reactionForFn}
    ${momentumForFn}
    ${postNewsMomentumFn}
    ${pairCurrenciesFn}
    ${eventAssetsFn}
    ${focusPairFn}
    ${postNewsExpiryFn}
    ${forecastBiasFn}
    ${preNewsBiasFn}
    ${invertDirFn}
    ${mapPairBiasFn}
    ${momentumFloorFn}
    ${reactionFloorFn}
    ${mapAssetBiasFn}
    ${mapActualBiasFn}
    ${core}
    ${signalDirectionCoreFn}
    ${applyMarketContextFn}
    ${signalDirectionFn}
    ${signalLockKeyFn}
    ${readSignalLockFn}
    ${writeSignalLockFn}
    ${assetPriceFn}
    ${clampNumFn}
    ${spreadConst}
    const MARKETS = null;
    const LIVE_BARS = {};
    ${marketsFreshFn}
    ${barsOfFn}
    ${assetBarsFn}
    ${atrInfoFn}
    ${structureStopDistanceFn}
    ${halfSpreadEstimateFn}
    ${execEntriesFn}
    function brokerQuoteFor() { return null; }
    ${computeSignalLevelsFn}
    ${levelsFromLockFn}
    ${missedFromLevelsFn}
    ${resolveSignalLevelsFn}
    ${signalCardDataFn}
    ${tpSlFn}
    return tpSl;
  `;
  return new Function('LIVE_PRICE', 'FOREX_RATES', 'CRYPTO_RATES', 'localStorage', 'PRE_NEWS', 'INDEX_RATES', body)(livePrice, forexRates, cryptoRates, store, preNews, indexRates);
}

const forexRates = { EUR: 0.92, GBP: 0.79, JPY: 150, CHF: 0.88, AUD: 0.65, CAD: 1.36 };
const cryptoRates = { 'BTC/USD': 65000, 'ETH/USD': 3200 };
const defaultIndexRates = {
  NAS100: { price: 21000, previousClose: 20800, changePct: 0.96 },
  US500: { price: 5800, previousClose: 5760, changePct: 0.69 }
};
const noStore = { getItem: () => null, setItem: () => {} };
const jsonStore = value => ({ getItem: () => JSON.stringify(value), setItem: () => {} });
const baseSnapshot = {
  gold: 3900,
  forex: { EUR: 0.95, GBP: 0.80, JPY: 155, CHF: 0.90, AUD: 0.66, CAD: 1.38 },
  crypto: { 'BTC/USD': 62000, 'ETH/USD': 3000 },
  capturedAt: new Date(Date.now() - 65 * 60 * 1000).toISOString(),
};

const pastUsd = { Date: new Date(Date.now() - 60 * 60 * 1000).toISOString(), Event: 'CPI', Country: 'USD', Importance: 3, Forecast: '3.0%', Actual: '' };
const pastAud = { ...pastUsd, Event: 'CPI m/m', Country: 'AUD' };
const futureUsd = { Date: new Date(Date.now() + 60 * 60 * 1000).toISOString(), Event: 'Nonfarm Payrolls', Country: 'USD', Importance: 3, Forecast: '200K', Actual: '' };

const breakoutHtml = buildTpSl(4000, forexRates, cryptoRates, noStore)({ dir: 'wait', score: 40 }, pastUsd);
assert.match(breakoutHtml, /POST-NEWS/);
assert.match(breakoutHtml, /BUY/);
assert.match(breakoutHtml, /SELL/);
assert.match(breakoutHtml, /TP:/);
assert.match(breakoutHtml, /EUR\/USD/);
assert.match(breakoutHtml, /BTC\/USD/);

// USD event: every USD-quoted pair uses its own momentum.
const usdHtml = buildTpSl(4000, forexRates, cryptoRates, jsonStore(baseSnapshot))({ dir: 'wait', score: 40 }, pastUsd);
assert.match(usdHtml, /POST-NEWS/);
assert.match(usdHtml, /XAU\/USD \(Gold\) — BUY/);
assert.match(usdHtml, /dari harga (tepat )?sebelum rilis|dari harga pra-rilis/);
assert.match(usdHtml, /EUR\/USD <b>BUY<\/b>/);
assert.match(usdHtml, /USD\/JPY <b>SELL<\/b>/);
assert.match(usdHtml, /BTC\/USD <b>BUY<\/b>/);

// AUD event: only AUD/USD gets a directional signal; gold and crypto panels are hidden.
const audHtml = buildTpSl(4000, forexRates, cryptoRates, jsonStore(baseSnapshot))({ dir: 'wait', score: 40 }, pastAud);
assert.match(audHtml, /POST-NEWS/);
assert.match(audHtml, /AUD\/USD <b>BUY<\/b>/);
assert.match(audHtml, /\+1\.54%/);
assert.doesNotMatch(audHtml, /XAU\/USD/);
assert.doesNotMatch(audHtml, /BTC\/USD/);
assert.doesNotMatch(audHtml, /ETH\/USD/);
assert.doesNotMatch(audHtml, /POST-NEWS BREAKOUT \(OCO\)/);
assert.doesNotMatch(audHtml, /EUR\/USD <b>BUY<\/b>/);
assert.doesNotMatch(audHtml, /USD\/JPY <b>SELL<\/b>/);

// AUD pre-news: no gold straddle or crypto panel either.
const futureAud = { ...futureUsd, Event: 'CPI m/m', Country: 'AUD' };
const audStraddleHtml = buildTpSl(4000, forexRates, cryptoRates, noStore)({ dir: 'wait', score: 40 }, futureAud);
assert.match(audStraddleHtml, /AUD\/USD/);
assert.doesNotMatch(audStraddleHtml, /XAU\/USD/);
assert.doesNotMatch(audStraddleHtml, /STRATEGI STRADDLE \(OCO\)/);
assert.doesNotMatch(audStraddleHtml, /BTC\/USD/);
assert.doesNotMatch(audStraddleHtml, /ETH\/USD/);

// Directed AUD event must not leak a gold panel either.
const audDirectedHtml = buildTpSl(4000, forexRates, cryptoRates, jsonStore(baseSnapshot))({ dir: 'long', score: 70 }, pastAud);
assert.doesNotMatch(audDirectedHtml, /XAU\/USD/);
assert.doesNotMatch(audDirectedHtml, /BTC\/USD/);
assert.doesNotMatch(audDirectedHtml, /ETH\/USD/);

// Legacy localStorage snapshot (gold only) is merged with per-pair repo data.
const localGold = { getItem: () => '3900', setItem: () => {} };
const repoForex = { [`${pastUsd.Date}|CPI`]: { forex: baseSnapshot.forex, crypto: baseSnapshot.crypto, capturedAt: baseSnapshot.capturedAt } };
const mergedHtml = buildTpSl(4000, forexRates, cryptoRates, localGold, repoForex)({ dir: 'wait', score: 40 }, pastUsd);
assert.match(mergedHtml, /EUR\/USD <b>BUY<\/b>/);
assert.match(mergedHtml, /USD\/JPY <b>SELL<\/b>/);
assert.match(mergedHtml, /dari harga (tepat )?sebelum rilis|dari harga pra-rilis/);

// Legacy repo snapshot ({price}) is still treated as a gold base price.
const repoSnapshots = { [`${pastUsd.Date}|CPI`]: { price: 3950, capturedAt: new Date(Date.parse(pastUsd.Date) - 5 * 60 * 1000).toISOString() } };
const repoHtml = buildTpSl(4000, forexRates, cryptoRates, noStore, repoSnapshots)({ dir: 'wait', score: 40 }, pastUsd);
assert.match(repoHtml, /XAU\/USD \(Gold\) — BUY/);
assert.match(repoHtml, /dari harga (tepat )?sebelum rilis|dari harga pra-rilis/);
assert.match(repoHtml, /EUR\/USD <b style="color:var\(--amber\)">BREAKOUT<\/b>/);

const straddleHtml = buildTpSl(4000, forexRates, cryptoRates, noStore)({ dir: 'wait', score: 40 }, futureUsd);
assert.match(straddleHtml, /STRADDLE/);
assert.match(straddleHtml, /BUY/);
assert.match(straddleHtml, /TP/);

// Pre-news forex majors: explicit market BUY/SELL bias from Forecast vs Previous.
const futureEurCpi = {
  Date: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  Event: 'CPI Flash Estimate y/y', Country: 'EUR', Importance: 3,
  Forecast: '4.0%', Previous: '3.8%', Actual: ''
};
const eurPre = buildTpSl(4000, forexRates, cryptoRates, noStore)({ dir: 'wait', score: 40 }, futureEurCpi);
assert.match(eurPre, /Entry pasar riil BUY/);
assert.match(eurPre, /EUR\/USD <b>BUY<\/b>/);
assert.match(eurPre, /pre-news market/);
assert.match(eurPre, /Entry pasar riil BUY/);
assert.doesNotMatch(eurPre, /XAU\/USD/);
assert.doesNotMatch(eurPre, /BTC\/USD/);

const futureUsdCpi = { ...futureEurCpi, Event: 'CPI', Country: 'USD', Forecast: '3.2%', Previous: '3.0%' };
const usdPre = buildTpSl(4000, forexRates, cryptoRates, noStore)({ dir: 'wait', score: 40 }, futureUsdCpi);
assert.match(usdPre, /Entry pasar riil SELL/);
assert.match(usdPre, /EUR\/USD <b>SELL<\/b>/);
assert.match(usdPre, /GBP\/USD <b>SELL<\/b>/);
assert.match(usdPre, /USD\/JPY <b>BUY<\/b>/);
assert.match(usdPre, /USD\/CHF <b>BUY<\/b>/);
assert.match(usdPre, /pre-news market/);
// Crypto now follows the same pre-news bias instead of always straddling.
assert.match(usdPre, /BTC\/USD <b>SELL<\/b>/);
assert.match(usdPre, /XAU\/USD \(Gold\) — SELL/);
// USD event also drives the index panel.
assert.match(usdPre, /Indices \(S&amp;P 500\)/);
assert.match(usdPre, /US500 <b>SELL<\/b>/);

const futureGbp = { ...futureEurCpi, Event: 'CPI y/y', Country: 'GBP', Forecast: '3.0%', Previous: '3.2%' };
const gbpPre = buildTpSl(4000, forexRates, cryptoRates, noStore)({ dir: 'wait', score: 40 }, futureGbp);
assert.match(gbpPre, /GBP\/USD <b>SELL<\/b>/);
assert.match(gbpPre, /GBP\/JPY <b>SELL<\/b>/);
assert.doesNotMatch(gbpPre, /USD\/JPY/);
assert.doesNotMatch(gbpPre, /EUR\/USD <b>BUY<\/b>/);

// Cross pairs follow the event currency leg.
assert.match(eurPre, /EUR\/JPY <b>BUY<\/b>/);
assert.match(usdPre, /GBP\/JPY <b style="color:var\(--amber\)">STRADDLE<\/b>/);
assert.match(usdPre, /EUR\/JPY <b style="color:var\(--amber\)">STRADDLE<\/b>/);
assert.doesNotMatch(eurPre, /NAS100/);

// Pure Forecast-vs-Previous bias and pair orientation mapping.
const forecastBias = new Function(`${core}\n${numFn}\n${countryFn}\n${biasFn}\n${forecastBiasFn}\nreturn forecastBias;`)();
assert.equal(forecastBias({ Event: 'CPI', Country: 'USD', Forecast: '3.2%', Previous: '3.0%' }).dir, 'short');
assert.equal(forecastBias({ Event: 'CPI', Country: 'EUR', Forecast: '4.0%', Previous: '3.8%' }).dir, 'long');
assert.equal(forecastBias({ Event: 'CPI', Country: 'USD', Forecast: '3.0%', Previous: '3.0%' }), null);
assert.equal(forecastBias({ Event: 'CPI', Country: 'USD', Forecast: '', Previous: '3.0%' }), null);

assert.equal(sentimentOverlay(10, -15).dir, 'long', 'extreme fear from CNN F&G -> long');
assert.equal(sentimentOverlay(85, 20).dir, 'short', 'extreme greed from CNN F&G -> short');
assert.equal(sentimentOverlay(50, 0), null, 'neutral sentiment -> no overlay');
assert.equal(sentimentOverlay(null, 5), null, 'missing score -> no overlay');

const mapPairBias = new Function(`${countryFn}\n${invertDirFn}\n${mapPairBiasFn}\nreturn mapPairBias;`)();
assert.equal(mapPairBias('EUR/USD', 'short'), 'short');
assert.equal(mapPairBias('USD/JPY', 'short'), 'long');
assert.equal(mapPairBias('USD/CAD', 'long'), 'short');
assert.equal(mapPairBias('EUR/USD', 'wait'), null);
// Currency-aware crosses: event currency on the base leg keeps direction, quote leg inverts.
assert.equal(mapPairBias('GBP/JPY', 'long', 'GBP'), 'long');
assert.equal(mapPairBias('GBP/JPY', 'long', 'JPY'), 'short');
assert.equal(mapPairBias('EUR/JPY', 'short', 'EUR'), 'short');
assert.equal(mapPairBias('EUR/JPY', 'short', 'JPY'), 'long');
assert.equal(mapPairBias('GBP/JPY', 'long', 'USD'), null);
assert.equal(mapPairBias('EUR/JPY', 'short', 'USD'), null);

const pairRateFrom = new Function(`${pairRateFromFn}\nreturn pairRateFrom;`)();
assert.ok(Math.abs(pairRateFrom(forexRates, 'EUR/USD') - 1 / 0.92) < 1e-9);
assert.ok(Math.abs(pairRateFrom(forexRates, 'GBP/JPY') - 150 / 0.79) < 1e-9);
assert.ok(Math.abs(pairRateFrom(forexRates, 'EUR/JPY') - 150 / 0.92) < 1e-9);
assert.equal(pairRateFrom({}, 'GBP/JPY'), null);
assert.equal(pairRateFrom(forexRates, 'BADPAIR'), null);

// Direct OANDA pair quotes must win over reconstructed USD-base rates.
const pairRateDirect = new Function('FOREX_QUOTES', 'FOREX_RATES', `${pairRateFromFn}\n${pairRateFn}\nreturn pairRate;`)(
  { 'EUR/USD': { price: 1.2 } },
  forexRates
);
assert.equal(pairRateDirect('EUR/USD'), 1.2);
assert.ok(Math.abs(pairRateDirect('GBP/JPY') - 150 / 0.79) < 1e-9);

const liveHtml = buildTpSl(4000, forexRates, cryptoRates, noStore)({ dir: 'wait', score: 40 }, { ...pastUsd, Date: new Date(Date.now() - 30 * 1000).toISOString() });
assert.match(liveHtml, /Rilis berlangsung/);

const lowImpactHtml = buildTpSl(4000, forexRates, cryptoRates, noStore)({ dir: 'wait', score: 40 }, { ...pastUsd, Importance: 1 });
assert.equal(lowImpactHtml, '');

const staleHtml = buildTpSl(4000, forexRates, cryptoRates, noStore)({ dir: 'wait', score: 40 }, { ...pastUsd, Date: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString() });
assert.match(staleHtml, /kedaluwarsa/);
assert.doesNotMatch(staleHtml, /BUY/);

// Post-news with no published Actual: workflow-calculated 1-minute reaction gives the direction.
const pastEurLow = {
  Date: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
  Event: 'Spanish Services PMI', Country: 'EUR', Importance: 1,
  Forecast: '57.6', Previous: '58.3', Actual: ''
};
const reactionPayload = {
  generatedAt: new Date().toISOString(),
  events: {
    [`${pastEurLow.Date}|${pastEurLow.Event}`]: {
      releasedAt: pastEurLow.Date,
      pairs: {
        'EUR/USD': { movePct: 0.15, dir: 'long', minutes: 45 },
        'USD/JPY': { movePct: 0.20, dir: 'long', minutes: 45 },
        'XAU/USD': { movePct: 0.31, dir: 'short', minutes: 45 }
      }
    }
  }
};
const eurReactionHtml = buildTpSl(4000, forexRates, cryptoRates, noStore, {}, defaultIndexRates, reactionPayload)(
  analyze({ ...pastEurLow }), pastEurLow
);
assert.notEqual(eurReactionHtml, '', 'Importance 1 event must publish levels once the price reaction is known');
assert.match(eurReactionHtml, /POST-NEWS/);
assert.match(eurReactionHtml, /EUR\/USD <b>BUY<\/b>/);
assert.match(eurReactionHtml, /valid s\/d/);
assert.doesNotMatch(eurReactionHtml, /NaN|undefined/);

// A stale reaction.json (older than the freshness window) must not drive any signal.
const staleReaction = {
  generatedAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
  events: reactionPayload.events
};
assert.equal(buildTpSl(4000, forexRates, cryptoRates, noStore, {}, defaultIndexRates, staleReaction)(
  analyze({ ...pastEurLow }), pastEurLow
), '');

console.log('Passed post-news per-pair momentum + TP tests');

// Direction ladder: Actual vs Forecast -> Actual vs Previous -> price reaction -> no data.
const eurCpiReleased = {
  Date: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
  Event: 'CPI', Country: 'EUR', Importance: 2,
  Forecast: '3.0%', Previous: '2.8%', Actual: '3.2%'
};
const ladderForecast = analyze(eurCpiReleased);
assert.equal(ladderForecast.dir, 'long');
assert.equal(ladderForecast.basis, 'actual-forecast');
assert.equal(ladderForecast.reference, 'Forecast');

const noForecast = analyze({ ...eurCpiReleased, Forecast: '' });
assert.equal(noForecast.basis, 'no-forecast');
assert.equal(noForecast.dir, 'wait');
assert.equal(noForecast.score, 0);

const pending = analyze({ ...eurCpiReleased, Date: new Date(Date.now() + 60 * 60 * 1000).toISOString(), Actual: '' });
assert.equal(pending.basis, 'forecast-pending');
assert.equal(pending.dir, 'wait');
assert.equal(pending.score, 0);

const noActual = analyze({ ...pastEurLow, Actual: '' });
assert.equal(noActual.noData, true);
assert.equal(noActual.basis, 'no-actual');
assert.equal(noActual.score, 0, 'no synthetic confidence for unpublished Actual');

// Pair mapping of the same EUR release.
assert.equal(mapPairBias('EUR/USD', ladderForecast.dir, 'EUR'), 'long');
assert.equal(mapPairBias('USD/JPY', ladderForecast.dir, 'EUR'), 'short');
assert.equal(mapPairBias('USD/CHF', ladderForecast.dir, 'EUR'), 'short');

// Pair board: a released event inside the post-news window beats a far-future one.
function buildCatalyst(eventList, reaction) {
  const body = `
    const POST_NEWS_HOLD_MS = 6 * 60 * 60 * 1000;
    const NEWS_SETTLE_MS = 15 * 60 * 1000;
    const MOMENTUM_WINDOW_MS = 90 * 60 * 1000;
    const SIGNAL_LOCK_PREFIX = 'feriha:signal:v2:';
    ${riskSensitiveConst}
    ${rateDrivenConst}
    const REACTION_MAX_AGE_MS = 45 * 60 * 1000;
    const REACTION = ${JSON.stringify(reaction)};
    const events = ${JSON.stringify(eventList)};
    const FOREX_RATES = ${JSON.stringify(forexRates)};
    const FOREX_QUOTES = null;
    const PRE_NEWS = {};
    const INDEX_RATES = ${JSON.stringify(defaultIndexRates)};
    const CRYPTO_RATES = {};
    const LIVE_PRICE = 4000;
    const MARKETS = null;
    const LIVE_BARS = {};
    const localStorage = { getItem: () => null, setItem: () => {} };
    ${clampNumFn}
    ${numFn}
    ${countryFn}
    ${biasFn}
    ${analyzeFn}
    ${dateEventKeyFn}
    ${eventKeyFn}
    ${normalizeSnapshotFn}
    ${preNewsSnapshotFn}
    ${preNewsPriceFn}
    ${pairRateFromFn}
    ${pairRateFn}
    ${moveNoteFn}
    ${barsOfFn}
    ${barBaseBeforeFn}
    ${reactionFromBarsClientFn}
    ${preReleaseAtrPctFn}
    ${reactionForFn}
    ${momentumForFn}
    ${forecastBiasFn}
    ${invertDirFn}
    ${mapPairBiasFn}
    ${momentumFloorFn}
    ${reactionFloorFn}
    ${mapAssetBiasFn}
    ${mapActualBiasFn}
    ${newsPhaseFn}
    ${core}
    ${signalDirectionCoreFn}
    ${applyMarketContextFn}
    ${signalDirectionFn}
    ${pairCurrenciesFn}
    ${nextPairCatalystFn}
    ${pairCatalystDirectionFn}
    return { nextPairCatalyst, pairCatalystDirection };
  `;
  return new Function(body)();
}

{
  const far = {
    Date: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
    Event: 'Nonfarm Payrolls', Country: 'EUR', Importance: 3, Forecast: '120K', Previous: '100K', Actual: ''
  };
  const { nextPairCatalyst, pairCatalystDirection } = buildCatalyst([pastEurLow, far], reactionPayload);
  const hit = nextPairCatalyst('EUR/USD');
  assert.ok(hit, 'EUR/USD must have an active catalyst');
  assert.equal(hit.phase, 'post');
  assert.equal(hit.e.Event, 'Spanish Services PMI', 'freshly released event must not be dropped from the board');
  assert.equal(pairCatalystDirection(hit.e, 'EUR/USD').dir, 'long');
  assert.equal(pairCatalystDirection(hit.e, 'USD/JPY').dir, 'long', 'reaction.json is asset-relative, so it is never re-mapped through mapPairBias');

  // Without reaction data the same event resolves to no direction but is still
  // shown so the board can explain why it waits.
  const bare = buildCatalyst([pastEurLow, far], null);
  assert.equal(bare.pairCatalystDirection(pastEurLow, 'EUR/USD').noData, true);
  const bareHit = bare.nextPairCatalyst('EUR/USD');
  assert.equal(bareHit.phase, 'post');
  assert.equal(bareHit.e.Event, 'Spanish Services PMI');
  // A pair with no catalyst at all renders a neutral card, never NaN.
  const lone = buildCatalyst([], null);
  assert.equal(lone.nextPairCatalyst('EUR/USD'), null);
}

{
  const releasedOnly = buildCatalyst([pastEurLow], null);
  const hit = releasedOnly.nextPairCatalyst('EUR/USD');
  assert.equal(hit.phase, 'post', 'undirected release is still shown so the board can explain why it waits');
  assert.equal(releasedOnly.pairCatalystDirection(hit.e, 'EUR/USD').noData, true);
}

console.log('Passed post-news direction ladder + pair catalyst tests');

// Global crypto board: always visible outside event cards.
const boardStart = source.indexOf('id="cryptoBoard"');
const calendarStart = source.indexOf('id="calendar"');
assert.ok(boardStart > -1, 'crypto board section missing');
assert.ok(calendarStart > -1 && boardStart < calendarStart, 'crypto board must render before the calendar');

const cryptoPairsConst = source.slice(
  source.indexOf('const CRYPTO_PAIRS = ['),
  source.indexOf('];', source.indexOf('const CRYPTO_PAIRS = [')) + 2
);
const cryptoBoardFn = extractFunction('cryptoBoardHtml');
const cryptoBoardHtml = new Function(`const esc = s => String(s ?? '');\nconst fmtTime = d => '13:00 WITA';\n${cryptoPairsConst}\n${spreadConst}\nconst MARKETS = null;\n${marketsFreshFn}\n${assetBarsFn}\n${atrInfoFn}\n${halfSpreadEstimateFn}\n${execEntriesFn}\nfunction brokerQuoteFor() { return null; }\n${cryptoBoardFn}\nreturn cryptoBoardHtml;`)();

const boardHtml = cryptoBoardHtml(
  { 'BTC/USD': 80934.65, 'ETH/USD': 3200.5 },
  { 'BTC/USD': 1.234, 'ETH/USD': -0.5 }
);
assert.match(boardHtml, /BTC\/USD/);
assert.match(boardHtml, /\$80,934\.65/);
assert.match(boardHtml, /\$3,200\.50/);
assert.match(boardHtml, /▲ \+1\.23% 24h/);
assert.match(boardHtml, /▼ -0\.50% 24h/);
assert.match(boardHtml, /SL\/TP 1% \/ 2%/);
assert.match(boardHtml, /SL\/TP 1\.5% \/ 3%/);

const boardNoChange = cryptoBoardHtml({ 'BTC/USD': 80000, 'ETH/USD': 3000 }, {});
assert.match(boardNoChange, /24h change n\/a/);
assert.doesNotMatch(boardNoChange, /NaN/);

const boardEmpty = cryptoBoardHtml({}, {});
assert.match(boardEmpty, /Menunggu harga crypto/);
assert.doesNotMatch(boardEmpty, /NaN|\$undefined/);

// With a signal state the same board prints real entry orders.
const cryptoState = {
  status: 'active', phase: 'post', event: 'CPI · Kam 05 Nov 12:00 WITA',
  validUntil: 'Kam 05 Nov 18:00 WITA',
  items: [
    { pair: 'BTC/USD', name: 'Bitcoin', slPct: 1.0, tpPct: 2.0, price: 78251, changePct: 1.16, dir: 'long', momPct: 0.271,
      levels: { entry: 78251, sl: 77468.49, tp: 79816.02, rr: 2 },
      note: 'Reaksi harga +0.27% dalam 40 mnt pasca-rilis — Actual tidak dipublikasikan' },
    { pair: 'ETH/USD', name: 'Ethereum', slPct: 1.5, tpPct: 3.0, price: 3200.5, changePct: -0.5, dir: null, momPct: null }
  ]
};
const cryptoBuy = cryptoBoardHtml({}, {}, cryptoState);
assert.match(cryptoBuy, /BUY · POST-NEWS/);
assert.match(cryptoBuy, /Entry 78,251\.00/);
assert.match(cryptoBuy, /SL 77,468\.49/);
assert.match(cryptoBuy, /TP 79,816\.02/);
assert.match(cryptoBuy, /Reaksi harga \+0\.27%/);
assert.match(cryptoBuy, /valid s\/d Kam 05 Nov 18:00 WITA/);
assert.match(cryptoBuy, /WAIT/);
assert.match(cryptoBuy, /BUY &gt; 3,225\.39/);
assert.match(cryptoBuy, /SELL &lt; 3,175\.62/);
assert.doesNotMatch(cryptoBuy, /· MARKET/);
assert.doesNotMatch(cryptoBuy, /NaN|undefined/);

// Same state in the pre-news phase is labelled MARKET, not POST-NEWS.
assert.match(cryptoBoardHtml({}, {}, { ...cryptoState, phase: 'pre' }), /BUY · MARKET/);

// Crypto state runs the same direction ladder as the pair board.
const cryptoStateFn = extractFunction('cryptoBoardState');
const nextUsdCatalystFn = extractFunction('nextUsdCatalyst');
function buildCryptoState(evts, now, rates, change, reaction = null) {
  const body = `
    ${cryptoPairsConst}
    const NEWS_SETTLE_MS = 15 * 60 * 1000;
    const MOMENTUM_WINDOW_MS = 90 * 60 * 1000;
    const SIGNAL_LOCK_PREFIX = 'feriha:signal:v2:';
    ${riskSensitiveConst}
    ${rateDrivenConst}
    const POST_NEWS_HOLD_MS = 6 * 60 * 60 * 1000;
    const REACTION_MAX_AGE_MS = 45 * 60 * 1000;
    const REACTION = ${JSON.stringify(reaction)};
    const PRE_NEWS = {};
    const LIVE_PRICE = null;
    const FOREX_RATES = {}, FOREX_QUOTES = {};
    const localStorage = { getItem: () => null, setItem: () => {} };
    const fmtDate = () => 'Kam 29 Okt';
    const fmtTime = () => '02:00 WITA';
    ${numFn}
    ${countryFn}
    ${biasFn}
    ${analyzeFn}
    ${dateEventKeyFn}
    ${postNewsExpiryFn}
    ${newsPhaseFn}
    ${normalizeSnapshotFn}
    ${preNewsSnapshotFn}
    ${eventKeyFn}
    ${momentumForFn}
    ${barsOfFn}
    ${barBaseBeforeFn}
    ${reactionFromBarsClientFn}
    ${preReleaseAtrPctFn}
    ${reactionForFn}
    ${moveNoteFn}
    ${indexRateFn}
    ${forecastBiasFn}
    ${preNewsBiasFn}
    ${invertDirFn}
    ${mapPairBiasFn}
    ${momentumFloorFn}
    ${reactionFloorFn}
    ${mapAssetBiasFn}
    ${mapActualBiasFn}
    ${core}
    ${signalDirectionCoreFn}
    ${applyMarketContextFn}
    ${signalDirectionFn}
    ${signalLockKeyFn}
    ${readSignalLockFn}
    ${writeSignalLockFn}
    ${assetPriceFn}
    ${clampNumFn}
    ${spreadConst}
    const MARKETS = null;
    const LIVE_BARS = {};
    ${marketsFreshFn}
    ${barsOfFn}
    ${assetBarsFn}
    ${atrInfoFn}
    ${structureStopDistanceFn}
    ${halfSpreadEstimateFn}
    ${execEntriesFn}
    function brokerQuoteFor() { return null; }
    ${computeSignalLevelsFn}
    ${levelsFromLockFn}
    ${missedFromLevelsFn}
    ${resolveSignalLevelsFn}
    ${signalCardDataFn}
    const pairRate = () => null;
    const pairRateFrom = () => null;
    ${nextUsdCatalystFn}
    ${cryptoStateFn}
    return cryptoBoardState;
  `;
  return new Function('events', 'CRYPTO_RATES', 'CRYPTO_CHANGE', body)(evts, rates, change)(now);
}

const cryptoLiveRates = { 'BTC/USD': 78251, 'ETH/USD': 3200.5 };
const cryptoLiveChange = { 'BTC/USD': 1.16, 'ETH/USD': -0.5 };
const cryptoNow = Date.now();
const cryptoFuture = { Date: new Date(cryptoNow + 60 * 60 * 1000).toISOString(), Event: 'CPI', Country: 'USD', Importance: 3, Forecast: '3.2', Previous: '3.0' };
const cryptoPast = { Date: new Date(cryptoNow - 60 * 60 * 1000).toISOString(), Event: 'Spanish Services PMI', Country: 'USD', Importance: 2, Forecast: '', Previous: '' };
const cryptoKey = `${cryptoPast.Date}|Spanish Services PMI`;

// No Actual: the 1-minute reaction decides per-asset direction (already asset-relative).
const cryptoReaction = {
  generatedAt: new Date(cryptoNow).toISOString(),
  events: { [cryptoKey]: { pairs: { 'BTC/USD': { dir: 'short', movePct: -0.25, minutes: 40 }, 'ETH/USD': { dir: 'long', movePct: 0.44, minutes: 40 } } } }
};
const cryptoPost = buildCryptoState([cryptoPast], cryptoNow, cryptoLiveRates, cryptoLiveChange, cryptoReaction);
assert.equal(cryptoPost.status, 'active');
assert.equal(cryptoPost.phase, 'post');
assert.deepEqual(cryptoPost.items.map(it => it.dir), ['short', 'long']);
assert.equal(cryptoPost.items[0].momPct, -0.25);
assert.match(cryptoPost.items[0].note, /Reaksi harga -0\.25% dalam 40 mnt/);
assert.match(cryptoBoardHtml({}, {}, cryptoPost), /SELL · POST-NEWS/);
assert.match(cryptoBoardHtml({}, {}, cryptoPost), /BUY · POST-NEWS/);

// Without reaction or momentum the card stays WAIT and says why.
const cryptoUnknown = buildCryptoState([cryptoPast], cryptoNow, cryptoLiveRates, cryptoLiveChange, null);
assert.deepEqual(cryptoUnknown.items.map(it => it.dir), [null, null]);
assert.match(cryptoBoardHtml({}, {}, cryptoUnknown), /NO ACTUAL DATA — belum ada reaksi harga/);

// A hotter-than-expected USD CPI is USD-stronger: risk assets go short, not long.
const cryptoPre = buildCryptoState([cryptoFuture], cryptoNow, cryptoLiveRates, cryptoLiveChange);
assert.equal(cryptoPre.phase, 'pre');
assert.deepEqual(cryptoPre.items.map(it => it.dir), ['short', 'short']);
assert.match(cryptoPre.items[0].note, /Forecast 3\.2 vs Previous 3/);
assert.match(cryptoBoardHtml({}, {}, cryptoPre), /SELL · MARKET/);

// No USD catalyst at all: idle, but the cards still render their prices.
const cryptoIdle = buildCryptoState([{ ...cryptoFuture, Country: 'EUR' }], cryptoNow, cryptoLiveRates, cryptoLiveChange);
assert.equal(cryptoIdle.status, 'idle');
assert.deepEqual(cryptoIdle.items.map(it => it.price), [78251, 3200.5]);

console.log('Passed global crypto board tests');

// Global forex board: always visible outside event cards.
const forexBoardStart = source.indexOf('id="forexBoard"');
assert.ok(forexBoardStart > -1, 'forex board section missing');
assert.ok(forexBoardStart < calendarStart, 'forex board must render before the calendar');

const forexBoardFn = extractFunction('forexBoardHtml');
const brokerLineFn = extractFunction('brokerLineHtml');
const fxTickFn = extractFunction('fxTickHtml');
const forexBoardHtml = new Function(`const esc = s => String(s ?? '');\n${brokerLineFn}\n${fxTickFn}\n${forexBoardFn}\nreturn forexBoardHtml;`)();

const fxBoard = forexBoardHtml({ items: [
  { pair: 'EUR/USD', rate: 1.08696, dir: 'long', eventLabel: 'CPI · Kam 05 Nov 12:00 WITA', note: 'Forecast 4 vs Previous 3.8', tick: { dir: 'up', pip: 1.4 },
    levels: { entry: 1.08696, sl: 1.08358, tp: 1.09371, rr: 2 } },
  { pair: 'USD/JPY', rate: 157.88, dir: 'short', eventLabel: 'NFP · Jum 06 Nov 20:30 WITA', note: 'Forecast 65K vs Previous 29K',
    levels: { entry: 157.88, sl: 158.35, tp: 156.94, rr: 2 } },
  { pair: 'USD/CAD', rate: 1.36, dir: null, eventLabel: '' }
] });
assert.match(fxBoard, /EUR\/USD/);
assert.match(fxBoard, /BUY · MARKET/);
assert.match(fxBoard, /Entry 1\.08696/);
assert.match(fxBoard, /▲ 1\.4 pip/, 'a live pull must show how far the price moved');
assert.match(fxBoard, /USD\/JPY/);
assert.match(fxBoard, /SELL · MARKET/);
assert.match(fxBoard, /Entry 157\.880/);
assert.match(fxBoard, /USD\/CAD/);
assert.match(fxBoard, /WAIT/);
assert.match(fxBoard, /Tidak ada katalis/);
assert.doesNotMatch(fxBoard, /NaN|undefined/);

const fxBoardEmpty = forexBoardHtml({ items: [] });
assert.match(fxBoardEmpty, /Menunggu data forex/);
assert.doesNotMatch(fxBoardEmpty, /NaN|undefined/);

const fxBoardSourced = forexBoardHtml({
  items: [{ pair: 'EUR/USD', rate: 1.12, dir: 'buy' }],
  source: 'Harga acuan OANDA (TradingView live). GO Markets, FBS & CMC Markets: cek quote di terminal broker.'
});
assert.match(fxBoardSourced, /Harga acuan OANDA/);
assert.match(fxBoardSourced, /GO Markets, FBS & CMC Markets/);
assert.doesNotMatch(fxBoardSourced, /NaN|undefined/);

// Exact MT5 broker bid/ask: fresh quotes drive the entry side, stale ones only display.
const brokerQuote = { bid: 1.20010, ask: 1.20030, spreadPips: 2.0, stale: false, ageMin: 2, brokerName: 'FBS Markets Inc.', accountType: 'demo' };
const fxBuyBroker = forexBoardHtml({ items: [{ pair: 'EUR/USD', rate: 1.2, dir: 'long', broker: brokerQuote, levels: { entry: 1.20030, sl: 1.19730, tp: 1.20630, rr: 2 } }] });
assert.match(fxBuyBroker, /Entry 1\.20030/, 'BUY must use the broker ask');
assert.match(fxBuyBroker, /SL 1\.19730/);
assert.match(fxBuyBroker, /TP 1\.20630/);
assert.match(fxBuyBroker, /bid 1\.20010 \/ ask 1\.20030/);
assert.match(fxBuyBroker, /spread 2\.0 pip/);
assert.match(fxBuyBroker, /FBS Markets Inc\. · demo/);
assert.doesNotMatch(fxBuyBroker, /STALE/);

const fxSellBroker = forexBoardHtml({ items: [{ pair: 'EUR/USD', rate: 1.2, dir: 'short', broker: brokerQuote, levels: { entry: 1.20010, sl: 1.20310, tp: 1.19410, rr: 2 } }] });
assert.match(fxSellBroker, /Entry 1\.20010/, 'SELL must use the broker bid');
assert.match(fxSellBroker, /SL 1\.20310/);
assert.match(fxSellBroker, /TP 1\.19410/);

const fxWaitBroker = forexBoardHtml({ items: [{ pair: 'EUR/USD', rate: 1.2, dir: null, broker: brokerQuote }] });
assert.match(fxWaitBroker, /BUY 1\.20030/);
assert.match(fxWaitBroker, /SELL 1\.20010/);

const fxStaleBroker = forexBoardHtml({ items: [{ pair: 'EUR/USD', rate: 1.12345, dir: 'long', broker: { ...brokerQuote, stale: true, ageMin: 47 }, levels: { entry: 1.12345, sl: 1.12007, tp: 1.13021, rr: 2 } }] });
assert.match(fxStaleBroker, /STALE 47 mnt/);
assert.match(fxStaleBroker, /Entry 1\.12345/, 'stale broker quote must not set the entry');
assert.match(fxStaleBroker, /bid 1\.20010 \/ ask 1\.20030/, 'stale quote is still displayed');
assert.doesNotMatch(fxStaleBroker, /NaN|undefined/);

// Broker payload parsing and freshness gate.
const brokerQuoteForFn = extractFunction('brokerQuoteFor');
const brokerQuoteFor = new Function('FOREX_BROKER', 'BROKER_QUOTE_MAX_AGE_MS', `${brokerQuoteForFn}\nreturn brokerQuoteFor;`);
const brokerPayload = {
  generatedAt: '2026-11-04T00:40:00Z',
  broker: { id: 'FBS', name: 'FBS', accountType: 'demo' },
  quotes: { 'EUR/USD': { bid: 1.2001, ask: 1.2003, spreadPips: 2 } }
};
const freshBroker = brokerQuoteFor(brokerPayload, 30 * 60 * 1000)('EUR/USD', Date.parse('2026-11-04T00:55:00Z'));
assert.equal(freshBroker.ask, 1.2003);
assert.equal(freshBroker.stale, false);
assert.equal(freshBroker.accountType, 'demo');
assert.equal(freshBroker.brokerName, 'FBS');
assert.ok(Math.abs(freshBroker.ageMin - 15) < 1e-9);
const staleBroker = brokerQuoteFor(brokerPayload, 30 * 60 * 1000)('EUR/USD', Date.parse('2026-11-04T01:20:00Z'));
assert.equal(staleBroker.stale, true);
const customAgeBroker = brokerQuoteFor({ ...brokerPayload, staleAfterSec: 900 }, 30 * 60 * 1000)('EUR/USD', Date.parse('2026-11-04T00:56:00Z'));
assert.equal(customAgeBroker.stale, true, 'payload staleAfterSec must override the 30 minute default');
const customAgeBrokerFresh = brokerQuoteFor({ ...brokerPayload, staleAfterSec: 1800 }, 30 * 60 * 1000)('EUR/USD', Date.parse('2026-11-04T00:56:00Z'));
assert.equal(customAgeBrokerFresh.stale, false);
assert.equal(brokerQuoteFor({ quotes: { 'EUR/USD': { bid: 0, ask: 1.2 } } }, 30 * 60 * 1000)('EUR/USD', Date.now()), null);
assert.equal(brokerQuoteFor({ quotes: { 'EUR/USD': { bid: 1.2, ask: 1.1 } } }, 30 * 60 * 1000)('EUR/USD', Date.now()), null);
assert.equal(brokerQuoteFor({}, 30 * 60 * 1000)('EUR/USD', Date.now()), null);

const brokerSourceTextFn = extractFunction('brokerSourceText');
const brokerSourceText = new Function('FOREX_BROKER', 'BROKER_QUOTE_MAX_AGE_MS', `${brokerSourceTextFn}\nreturn brokerSourceText;`)(brokerPayload, 30 * 60 * 1000);
assert.match(brokerSourceText(Date.parse('2026-11-04T00:55:00Z')), /Quote broker FBS \(demo\) fresh 15 mnt/);
assert.match(brokerSourceText(Date.parse('2026-11-04T01:20:00Z')), /stale 40 mnt/);

// Post-release cards carry the POST-NEWS badge and an expiry, not the pre-news MARKET label.
const postBoard = forexBoardHtml({ items: [
  { pair: 'EUR/USD', rate: 1.08696, dir: 'long', phase: 'post', noData: false,
    eventLabel: 'Spanish Services PMI · Rab 04 Nov 16:15 WITA',
    note: 'Reaksi harga +0.12% dalam 45 mnt pasca-rilis — Actual tidak dipublikasikan',
    levels: { entry: 1.08696, sl: 1.08358, tp: 1.09371, rr: 2 },
    validUntil: 'Rab 04 Nov 22:15 WITA' },
  { pair: 'GBP/USD', rate: 1.34880, dir: null, phase: 'post', noData: true,
    eventLabel: 'Spanish Services PMI · Rab 04 Nov 16:15 WITA',
    note: 'NO ACTUAL DATA — arah belum terkonfirmasi', validUntil: 'Rab 04 Nov 22:15 WITA' }
] });
assert.match(postBoard, /EUR\/USD/);
assert.match(postBoard, /BUY · POST-NEWS/);
assert.doesNotMatch(postBoard, /· MARKET/);
assert.match(postBoard, /valid s\/d Rab 04 Nov 22:15 WITA/);
assert.match(postBoard, /NO ACTUAL DATA — arah belum terkonfirmasi/);
assert.match(postBoard, /WAIT/);
assert.doesNotMatch(postBoard, /NaN|undefined|null/);

console.log('Passed global forex board tests');

// Global index board: Nasdaq 100 and S&P 500 driven by the USD catalyst.
const indicesBoardStart = source.indexOf('id="indicesBoard"');
assert.ok(indicesBoardStart > -1, 'indices board section missing');
assert.ok(indicesBoardStart < calendarStart, 'indices board must render before the calendar');

const indicesBoardFn = extractFunction('indicesBoardHtml');
const indicesBoardHtml = new Function(`const esc = s => String(s ?? '');\nconst fmtTime = d => '13:00 WITA';\n${spreadConst}\nconst MARKETS = null;\n${marketsFreshFn}\n${assetBarsFn}\n${atrInfoFn}\n${halfSpreadEstimateFn}\n${execEntriesFn}\nfunction brokerQuoteFor() { return null; }\n${indicesBoardFn}\nreturn indicesBoardHtml;`)();

const idxBoard = indicesBoardHtml({
  status: 'active', phase: 'pre', event: 'CPI · Kam 05 Nov 12:00 WITA', note: 'Forecast 3.2 vs Previous 3.0',
  items: [
    { symbol: 'NAS100', name: 'Nasdaq 100', slPct: 1.0, tpPct: 2.0, price: 28180.26, changePct: 0.68, dir: 'short', momPct: null,
      levels: { entry: 28180.26, sl: 28462.06, tp: 27616.65, rr: 2 } },
    { symbol: 'US500', name: 'S&P 500', slPct: 0.75, tpPct: 1.5, price: 7568.92, changePct: 0.36, dir: null, momPct: null }
  ]
});
assert.match(idxBoard, /NAS100/);
assert.match(idxBoard, /SELL · MARKET/);
assert.match(idxBoard, /Entry 28,180\.26/);
assert.match(idxBoard, /SL 28,462\.06/);
assert.match(idxBoard, /TP 27,616\.65/);
assert.match(idxBoard, /US500/);
assert.match(idxBoard, /WAIT/);
assert.match(idxBoard, /BUY &gt; 7,597\.46/);
assert.match(idxBoard, /SELL &lt; 7,540\.39/);
assert.match(idxBoard, /SL\/TP 1% \/ 2%/);
assert.match(idxBoard, /SL\/TP 0\.75% \/ 1\.5%/);
assert.doesNotMatch(idxBoard, /NaN|undefined/);
assert.doesNotMatch(idxBoard, /\+0\.00%/);

const idxBoardNoPrice = indicesBoardHtml({ status: 'loading', items: [{ symbol: 'NAS100', name: 'Nasdaq 100', slPct: 1, tpPct: 2, price: null }] });
assert.match(idxBoardNoPrice, /Menunggu harga index/);
assert.doesNotMatch(idxBoardNoPrice, /NaN|undefined/);

const idxStateFn = extractFunction('indicesBoardState');
function buildIndicesState(evts, idxRates, now, analyzeBody = "() => ({ dir: 'wait' })", preBiasBody = '() => null', momentumBody = '() => null', reactionBody = '() => null') {
  const body = `
    const WITA = 'Asia/Makassar';
    const NEWS_SETTLE_MS = 60 * 1000;
    const MOMENTUM_WINDOW_MS = 90 * 60 * 1000;
    const SIGNAL_LOCK_PREFIX = 'feriha:signal:v2:';
    ${riskSensitiveConst}
    ${rateDrivenConst}
    const POST_NEWS_HOLD_MS = 6 * 60 * 60 * 1000;
    const INDICES = [
      { symbol: 'US500', name: 'S&P 500', yahoo: '^GSPC', slPct: 0.75, tpPct: 1.5 }
    ];
    const countryCode = c => String(c || 'USD').toUpperCase();
    const fmtDate = () => 'Kam 29 Okt';
    const fmtTime = () => '02:00 WITA';
    const postNewsExpiry = e => new Date(new Date(e.Date).getTime() + POST_NEWS_HOLD_MS);
    const newsPhase = e => {
      const t = new Date(e.Date).getTime();
      if (!Number.isFinite(t) || Date.now() < t) return 'pre';
      if (Date.now() < t + NEWS_SETTLE_MS) return 'live';
      return 'post';
    };
    const analyze = ${analyzeBody};
    const preNewsBias = ${preBiasBody};
    const momentumFor = ${momentumBody};
    const reactionFor = ${reactionBody};
    const moveNote = ${moveNoteFn};
    const localStorage = { getItem: () => null, setItem: () => {} };
    ${indexRateFn}
    ${momentumFloorFn}
    ${reactionFloorFn}
    ${mapAssetBiasFn}
    ${mapActualBiasFn}
    ${core}
    ${signalDirectionCoreFn}
    ${applyMarketContextFn}
    ${signalDirectionFn}
    ${signalLockKeyFn}
    ${readSignalLockFn}
    ${writeSignalLockFn}
    ${assetPriceFn}
    ${clampNumFn}
    ${spreadConst}
    const MARKETS = null;
    const LIVE_BARS = {};
    ${marketsFreshFn}
    ${barsOfFn}
    ${assetBarsFn}
    ${atrInfoFn}
    ${structureStopDistanceFn}
    ${halfSpreadEstimateFn}
    ${execEntriesFn}
    function brokerQuoteFor() { return null; }
    ${computeSignalLevelsFn}
    ${levelsFromLockFn}
    ${missedFromLevelsFn}
    ${resolveSignalLevelsFn}
    ${signalCardDataFn}
    ${nextUsdCatalystFn}
    ${idxStateFn}
    return indicesBoardState;
  `;
  return new Function('events', 'INDEX_RATES', body)(evts, idxRates)(now);
}

const idxRates = {
  US500: { price: 5800, previousClose: 5760, changePct: 0.69 }
};
const idxNow = Date.now();
const idxFutureUsd = { Date: new Date(idxNow + 60 * 60 * 1000).toISOString(), Event: 'CPI', Country: 'USD', Importance: 3, Forecast: '3.2%', Previous: '3.0%' };
const idxPastUsd = { ...idxFutureUsd, Date: new Date(idxNow - 60 * 60 * 1000).toISOString() };

const idxPreState = buildIndicesState([idxFutureUsd], idxRates, idxNow, "() => ({ dir: 'wait' })", "() => ({ dir: 'short', forecast: 3.2, previous: 3.0 })");
assert.equal(idxPreState.status, 'active');
assert.equal(idxPreState.phase, 'pre');
assert.deepEqual(idxPreState.items.map(x => x.dir), ['short']);
assert.ok(/Forecast 3\.2 vs Previous 3/.test(idxPreState.items[0].note));

const idxWaitState = buildIndicesState([idxFutureUsd], idxRates, idxNow);
assert.deepEqual(idxWaitState.items.map(x => x.dir), [null]);

const idxPostDirected = buildIndicesState([idxPastUsd], idxRates, idxNow, "() => ({ dir: 'long' })");
assert.deepEqual(idxPostDirected.items.map(x => x.dir), ['long']);

const idxPostMomentum = buildIndicesState([idxPastUsd], idxRates, idxNow, "() => ({ dir: 'wait' })", '() => null', "(e, kind, symbol) => ({ dir: 'short', changePct: -0.21 })");
assert.deepEqual(idxPostMomentum.items.map(x => x.dir), ['short']);
assert.equal(idxPostMomentum.items[0].momPct, -0.21);

// Index reactions measured from the futures backup say so on the card.
const idxPostVia = buildIndicesState([idxPastUsd], idxRates, idxNow, "() => ({ dir: 'wait', noData: true })", '() => null', '() => null', "(e, symbol) => ({ dir: 'long', movePct: 0.238, minutes: 40, via: 'ES=F' })");
assert.deepEqual(idxPostVia.items.map(x => x.dir), ['long']);
assert.match(idxPostVia.items[0].note, /dalam 40 mnt pasca-rilis — Actual tidak dipublikasikan \(bar ES=F\)/);
assert.match(indicesBoardHtml(idxPostVia), /\(bar ES=F\)/);
assert.doesNotMatch(indicesBoardHtml(idxPostVia), /\+0\.00%/);
assert.match(indicesBoardHtml(idxPostVia), /\+0\.24%<\/small>/);

const idxIdle = buildIndicesState([{ ...idxFutureUsd, Country: 'EUR' }], idxRates, idxNow);
assert.equal(idxIdle.status, 'idle');

const idxLive = buildIndicesState([{ ...idxPastUsd, Date: new Date(idxNow - 30 * 1000).toISOString() }], idxRates, idxNow);
assert.equal(idxLive.status, 'live');

const idxNoPrice = buildIndicesState([idxFutureUsd], {}, idxNow);
assert.ok(idxNoPrice.items.every(x => !Number.isFinite(x.price)));

console.log('Passed global index board tests');

// Global gold board: always visible outside event cards.
const goldStart = source.indexOf('id="goldBoard"');
assert.ok(goldStart > -1, 'gold board section missing');
assert.ok(goldStart < calendarStart, 'gold board must render before the calendar');

const goldBoardFn = extractFunction('goldBoardHtml');
const goldBoardHtml = new Function(`
  const esc = s => String(s ?? '');
  function watchFactorsHtml() { return ''; }
  function spikeBadgeHtml() { return ''; }
  ${goldBoardFn}
  return goldBoardHtml;
`)();

const goldPre = goldBoardHtml(4042.4, {
  status: 'pre',
  event: 'FOMC · Kam 29 Okt 02:00 WITA',
  buy: { entry: 4048.46, sl: 4036.34, tp: 4072.72 },
  sell: { entry: 4036.34, sl: 4048.46, tp: 4012.06 }
});
assert.match(goldPre, /\$4,042\.40/);
assert.match(goldPre, /FOMC/);
assert.match(goldPre, /BUY STOP/);
assert.match(goldPre, /SELL STOP/);
assert.match(goldPre, /Entry 4048\.46/);
assert.match(goldPre, /SL 4036\.34/);
assert.match(goldPre, /TP 4072\.72/);
assert.match(goldPre, /Straddle OCO/);

const goldPostLong = goldBoardHtml(4042.4, {
  status: 'post', event: 'FOMC', dir: 'long', changePct: 0.42, validUntil: 'Kam 29 Okt 10:00 WITA',
  levels: { entry: 4042.4, sl: 4022.19, tp: 4082.82 }
});
assert.match(goldPostLong, /BUY • reaksi \+0\.42%/);
assert.match(goldPostLong, /Entry 4042\.40/);
assert.match(goldPostLong, /SL 4022\.19/);
assert.match(goldPostLong, /TP 4082\.82/);
assert.match(goldPostLong, /valid s\/d Kam 29 Okt 10:00 WITA/);
assert.doesNotMatch(goldPostLong, /SELL/);

const goldPostShort = goldBoardHtml(4000, {
  status: 'post', event: 'CPI', dir: 'short',
  levels: { entry: 4000, sl: 4020, tp: 3960 }
});
assert.match(goldPostShort, /SELL/);
assert.doesNotMatch(goldPostShort, /• reaksi/);
assert.doesNotMatch(goldPostShort, /NaN/);

const goldBreakout = goldBoardHtml(4000, {
  status: 'post', dir: null, validUntil: 'x',
  buy: { entry: 4010, sl: 3995, tp: 4040 },
  sell: { entry: 3990, sl: 4005, tp: 3960 }
});
assert.match(goldBreakout, /BUY BREAKOUT/);
assert.match(goldBreakout, /SELL BREAKOUT/);
assert.match(goldBreakout, /breakout OCO/);

assert.match(goldBoardHtml(4000, { status: 'live', event: 'FOMC' }), /Rilis berlangsung/);

const goldIdle = goldBoardHtml(4000, { status: 'idle', next: 'FOMC · Kam 29 Okt 02:00 WITA' });
assert.match(goldIdle, /Tidak ada katalis USD aktif/);
assert.match(goldIdle, /Berikutnya: FOMC/);

const goldNoPrice = goldBoardHtml(null, { status: 'loading' });
assert.match(goldNoPrice, /—/);
assert.match(goldNoPrice, /Menunggu harga gold live/);
assert.doesNotMatch(goldNoPrice, /NaN|\$undefined/);

// Gold board state picks the right phase and levels.
const stateFn = extractFunction('goldBoardState');
function buildGoldState(evts, price, now, analyzeBody = "() => ({ dir: 'wait' })", momentumBody = '() => null', biasBody = '() => null', reactionBody = '() => null') {
  const body = `
    const WITA = 'Asia/Makassar';
    const NEWS_SETTLE_MS = 60 * 1000;
    const MOMENTUM_WINDOW_MS = 90 * 60 * 1000;
    const SIGNAL_LOCK_PREFIX = 'feriha:signal:v2:';
    ${riskSensitiveConst}
    ${rateDrivenConst}
    const POST_NEWS_HOLD_MS = 6 * 60 * 60 * 1000;
    const countryCode = c => String(c || 'USD').toUpperCase();
    const esc = s => String(s);
    const fmtDate = () => 'Kam 29 Okt';
    const fmtTime = () => '02:00 WITA';
    const postNewsExpiry = e => new Date(new Date(e.Date).getTime() + POST_NEWS_HOLD_MS);
    const analyze = ${analyzeBody};
    const preNewsBias = ${biasBody};
    const reactionFor = ${reactionBody};
    const moveNote = ${moveNoteFn};
    const mapPairBias = ${mapPairBiasFn};
    const invertDir = ${invertDirFn};
    const momentumFor = ${momentumBody};
    const localStorage = { getItem: () => null, setItem: () => {} };
    ${momentumFloorFn}
    ${reactionFloorFn}
    ${mapAssetBiasFn}
    ${mapActualBiasFn}
    ${newsPhaseFn}
    ${core}
    ${signalDirectionCoreFn}
    ${applyMarketContextFn}
    ${signalDirectionFn}
    ${signalLockKeyFn}
    ${readSignalLockFn}
    ${writeSignalLockFn}
    ${assetPriceFn}
    ${clampNumFn}
    ${spreadConst}
    const MARKETS = null;
    const LIVE_BARS = {};
    ${marketsFreshFn}
    ${barsOfFn}
    ${assetBarsFn}
    ${atrInfoFn}
    ${structureStopDistanceFn}
    ${halfSpreadEstimateFn}
    ${execEntriesFn}
    function brokerQuoteFor() { return null; }
    ${computeSignalLevelsFn}
    ${levelsFromLockFn}
    ${missedFromLevelsFn}
    ${resolveSignalLevelsFn}
    ${signalCardDataFn}
    ${nextUsdCatalystFn}
    ${stateFn}
    return goldBoardState;
  `;
  return new Function('events', 'LIVE_PRICE', body)(evts, price)(now);
}

const now = Date.now();
const usdFuture = { Date: new Date(now + 60 * 60 * 1000).toISOString(), Event: 'FOMC', Country: 'USD', Importance: 3 };
const usdPast = { Date: new Date(now - 60 * 60 * 1000).toISOString(), Event: 'CPI', Country: 'USD', Importance: 3 };
const usdStale = { Date: new Date(now - 7 * 60 * 60 * 1000).toISOString(), Event: 'NFP', Country: 'USD', Importance: 3 };
const audFuture = { Date: new Date(now + 60 * 60 * 1000).toISOString(), Event: 'CPI m/m', Country: 'AUD', Importance: 3 };

const preState = buildGoldState([usdFuture], 4000, now);
assert.equal(preState.status, 'pre');
// Entry sekarang spread-aware: BUY di ask (mid + setengah spread emas 0.0075% = $0.15),
// SELL di bid. Buffer straddle tetap 0.15% x faktor impact.
assert.ok(Math.abs(preState.buy.entry - 4007.65) < 1e-9);
assert.ok(Math.abs(preState.buy.sl - 3992.65) < 1e-9);
assert.ok(Math.abs(preState.buy.tp - 4037.65) < 1e-9);
assert.ok(Math.abs(preState.sell.entry - 3992.35) < 1e-9);
assert.ok(Math.abs(preState.sell.tp - 3962.35) < 1e-9);

const postBreakout = buildGoldState([usdPast], 4000, now);
assert.equal(postBreakout.status, 'post');
assert.equal(postBreakout.dir, null);
assert.ok(Math.abs(postBreakout.buy.entry - 4012.65) < 1e-9);
assert.ok(Math.abs(postBreakout.buy.sl - 3993.9) < 1e-9);
assert.ok(Math.abs(postBreakout.buy.tp - 4050.15) < 1e-9);

// Pre-news with a Forecast-vs-Previous edge now prints a real entry, and the
// straddle stays visible so the OCO plan is not lost.
const preBiasState = buildGoldState([usdFuture], 4000, now, "() => ({ dir: 'wait' })", '() => null', "() => ({ dir: 'short', forecast: 3.2, previous: 3.0 })");
assert.equal(preBiasState.status, 'pre');
assert.equal(preBiasState.dir, 'short');
assert.equal(preBiasState.status, 'pre');
assert.ok(Math.abs(preBiasState.levels.entry - 3999.85) < 1e-9);
assert.ok(Math.abs(preBiasState.levels.sl - 4028.7489275) < 1e-6);
assert.ok(Math.abs(preBiasState.levels.tp - 3942.052145) < 1e-6);
assert.ok(preBiasState.buy && preBiasState.sell, 'straddle levels must survive the pre-news bias');
assert.match(preBiasState.note, /Forecast 3\.2 vs Previous 3/);
const preBiasHtml = goldBoardHtml(4000, preBiasState);
assert.match(preBiasHtml, /SELL · (MARKET|PRE-NEWS)/);
assert.match(preBiasHtml, /Entry 3999\.85/);
assert.match(preBiasHtml, /Straddle OCO tetap tersedia bila arah tidak diambil\./);
assert.match(preBiasHtml, /BUY STOP/);
assert.doesNotMatch(preBiasHtml, /NaN|undefined/);

// A flat Actual (basis 'flat') still gets measured from the 1-minute bars.
const flatActualReaction = buildGoldState([usdPast], 4000, now, "() => ({ dir: 'wait', basis: 'flat' })", '() => null', '() => null', "() => ({ dir: 'long', movePct: 0.25, minutes: 40, via: null })");
assert.equal(flatActualReaction.dir, 'long');
assert.equal(flatActualReaction.changePct, 0.25);
assert.match(flatActualReaction.note, /Actual sesuai perkiraan/);

// Reactions measured from a backup bar source stay honest about it.
const viaReaction = buildGoldState([usdPast], 4000, now, "() => ({ dir: 'wait', noData: true })", '() => null', '() => null', "() => ({ dir: 'short', movePct: -0.2, minutes: 30, via: 'XAUUSD' })");
assert.equal(viaReaction.dir, 'short');
assert.match(viaReaction.note, /\(bar XAUUSD\)/);

const postDirected = buildGoldState([usdPast], 4000, now, "() => ({ dir: 'short' })");
assert.equal(postDirected.status, 'post');
assert.equal(postDirected.dir, 'short');
assert.ok(Math.abs(postDirected.levels.sl - 4028.7489275) < 1e-6);
assert.ok(Math.abs(postDirected.levels.tp - 3942.052145) < 1e-6);

const postMomentum = buildGoldState([usdPast], 4000, now, "() => ({ dir: 'wait' })", "() => ({ dir: 'long', changePct: 0.35 })");
assert.equal(postMomentum.dir, 'long');
assert.equal(postMomentum.changePct, 0.35);

const staleState = buildGoldState([usdStale], 4000, now);
assert.equal(staleState.status, 'idle');
assert.equal(staleState.next, '');

const audOnlyState = buildGoldState([audFuture], 4000, now);
assert.equal(audOnlyState.status, 'idle');
assert.equal(audOnlyState.next, '');

const liveState = buildGoldState([{ ...usdPast, Date: new Date(now - 30 * 1000).toISOString() }], 4000, now);
assert.equal(liveState.status, 'live');

const noPriceState = buildGoldState([usdFuture], null, now);
assert.equal(noPriceState.status, 'loading');

console.log('Passed global gold board tests');

// Live pair prices: the board pulls TradingView's keyless scanner from the browser,
// falls back to data/forex.json, and shows how far each price moved per pull.
const liveFx = `
  const FOREX_PAIRS = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'AUD/USD', 'USD/CAD', 'NZD/USD', 'GBP/JPY', 'EUR/JPY'];
  const WITA = 'Asia/Makassar';
  ${extractFunction('forexScanTickers')}
  ${extractFunction('parseForexScan')}
  ${extractFunction('forexMedian')}
  ${extractFunction('forexRatesFromQuotes')}
  ${extractFunction('buildForexScanPayload')}
  ${extractFunction('forexTicks')}
  ${extractFunction('forexSourceText')}
  return { forexScanTickers, parseForexScan, forexMedian, forexRatesFromQuotes, buildForexScanPayload, forexTicks, forexSourceText };
`;
const FOREX_FEED_IDS = ['OANDA', 'GOMARKETS', 'CMCMARKETS', 'FBS', 'SAXO', 'FOREXCOM', 'CAPITALCOM', 'PEPPERSTONE', 'VANTAGE', 'FPMARKETS', 'EIGHTCAP', 'BLACKBULL', 'THINKMARKETS', 'SKILLING'];
const FOREX_FEED_NAMES = { OANDA: 'OANDA', GOMARKETS: 'GO Markets', CMCMARKETS: 'CMC Markets', FBS: 'FBS', SAXO: 'Saxo', FOREXCOM: 'FOREX.com', CAPITALCOM: 'Capital.com', PEPPERSTONE: 'Pepperstone', VANTAGE: 'Vantage', FPMARKETS: 'FP Markets', EIGHTCAP: 'Eightcap', BLACKBULL: 'BlackBull Markets', THINKMARKETS: 'ThinkMarkets', SKILLING: 'Skilling' };
const fxLive = new Function('FOREX_FEED_IDS', 'FOREX_FEED_NAMES', liveFx)(FOREX_FEED_IDS, FOREX_FEED_NAMES);

{
  const tickers = fxLive.forexScanTickers();
  assert.equal(tickers.length, FOREX_FEED_IDS.length * 9);
  assert.ok(tickers.includes('OANDA:EURUSD') && tickers.includes('SKILLING:EURJPY'));
  assert.ok(!tickers.some(t => /:EUR\/USD$/.test(t)), 'scanner symbols must be slash-free');
}

{
  const feeds = fxLive.parseForexScan({ data: [
    { s: 'OANDA:EURUSD', d: ['EURUSD', 1.12558, 0.57, 'streaming'] },
    { s: 'OANDA:USDJPY', d: ['USDJPY', 158.441, -0.16, 'streaming'] },
    { s: 'SAXO:EURUSD', d: ['EURUSD', 1.12570, 0.57, 'streaming'] },
    { s: 'BOGUS:EURUSD', d: ['EURUSD', 9.99, 0, 'streaming'] },
    { s: 'OANDA:USDKRW', d: ['USDKRW', 1400, 0, 'streaming'] },
    { s: 'OANDA:GBPUSD', d: ['GBPUSD', 0, 0, 'streaming'] },
    { s: 'OANDA:', d: ['X', 1.2, 0] }
  ] });
  assert.deepEqual(Object.keys(feeds).sort(), ['OANDA', 'SAXO']);
  assert.equal(feeds.OANDA['EUR/USD'].price, 1.12558);
  assert.equal(feeds.OANDA['EUR/USD'].changePct, 0.57);
  assert.equal(feeds.OANDA['USD/JPY'].changePct, -0.16);
  assert.equal(feeds.OANDA['GBP/USD'], undefined, 'a non-positive price is not a quote');
  assert.deepEqual(fxLive.parseForexScan(null), {});
  assert.deepEqual(fxLive.parseForexScan({ data: 'nope' }), {});
}

{
  const payload = fxLive.buildForexScanPayload(fxLive.parseForexScan({ data: [
    { s: 'OANDA:EURUSD', d: ['EURUSD', 1.12558, 0.57, 'streaming'] },
    { s: 'SAXO:EURUSD', d: ['EURUSD', 1.12570, 0.57, 'streaming'] },
    { s: 'PEPPERSTONE:EURUSD', d: ['EURUSD', 1.12560, 0.57, 'streaming'] },
    { s: 'OANDA:GBPJPY', d: ['GBPJPY', 198.55, -0.12, 'streaming'] }
  ] }), new Date('2026-11-04T08:00:00Z'));
  const eur = payload.quotes['EUR/USD'];
  assert.equal(eur.price, 1.12558, 'OANDA stays the anchor');
  assert.equal(eur.consensus, 1.12560, 'consensus is the broker median');
  assert.equal(eur.source, 'OANDA');
  assert.equal(eur.crossCheckPct, Number(((0.00012 / 1.12558) * 100).toFixed(3)));
  assert.equal(eur.updatedAt, '2026-11-04T08:00:00.000Z');
  assert.equal(payload.quotes['GBP/JPY'].source, 'OANDA');
  assert.equal(payload.quotes['GBP/USD'], undefined, 'a pair without quotes is skipped, never rendered as NaN');
  assert.equal(payload.rates.USD, 1);
  assert.ok(Math.abs(payload.rates.EUR - 1 / 1.12558) < 1e-12);
  assert.ok(Math.abs(payload.rates.JPY - 158.441) < 1e-9 || payload.rates.JPY === undefined);
  assert.equal(payload.providers.SAXO.status, 'ok');
  assert.equal(payload.providers.FBS.status, 'unavailable');
  assert.deepEqual(fxLive.buildForexScanPayload({}, new Date('2026-11-04T08:00:00Z')).quotes, {});
}

{
  // A broker-only pair (OANDA down) still prices off the consensus median.
  const payload = fxLive.buildForexScanPayload({ SAXO: { 'EUR/USD': { price: 1.10 } }, VANTAGE: { 'EUR/USD': { price: 1.12 } } }, new Date('2026-11-04T08:00:00Z'));
  assert.equal(payload.quotes['EUR/USD'].price, 1.11);
  assert.equal(payload.quotes['EUR/USD'].source, 'broker consensus');
}

{
  const buildTicks = prevQuotes => new Function('FOREX_QUOTES', `${extractFunction('forexTicks')}\nreturn forexTicks;`)(prevQuotes);
  const quotes = { 'EUR/USD': { price: 1.12558 }, 'USD/JPY': { price: 158.441 }, 'GBP/USD': { price: 1.34880 }, 'AUD/USD': { price: 0.65 } };
  assert.deepEqual(buildTicks({})(quotes), {}, 'the first pull has nothing to compare against');
  const tick = buildTicks(quotes);
  assert.deepEqual(tick({ 'EUR/USD': { price: 1.12558 } }), {}, 'an unchanged price shows no arrow');
  const moved = tick({ 'EUR/USD': { price: 1.12580 }, 'USD/JPY': { price: 158.431 }, 'GBP/USD': { price: 1.34880 }, 'AUD/USD': { price: 0.64990 }, 'NZD/USD': { price: 0.58 }, 'USD/CHF': { price: -1 } });
  assert.equal(moved['EUR/USD'].dir, 'up');
  assert.ok(Math.abs(moved['EUR/USD'].pip - 2.2) < 1e-6, 'majors count 0.0001 as a pip');
  assert.equal(moved['USD/JPY'].dir, 'down');
  assert.ok(Math.abs(moved['USD/JPY'].pip - 1.0) < 1e-6, 'JPY pairs count 0.01 as a pip');
  assert.equal(moved['GBP/USD'], undefined);
  assert.equal(moved['AUD/USD'].dir, 'down');
  assert.equal(moved['NZD/USD'], undefined, 'a pair with no previous price has no delta');
  assert.equal(moved['USD/CHF'], undefined, 'a broken new price is ignored');
}

{
  assert.match(fxLive.forexSourceText({ source: 'OANDA (live scanner)', live: true, providers: { SAXO: { name: 'Saxo', status: 'ok' } } }), /LIVE — scanner TradingView ditarik ulang tiap 20 detik/);
  assert.match(fxLive.forexSourceText({ source: 'OANDA (TradingView live)', live: false }), /SNAPSHOT 15 MENIT/);
  assert.match(fxLive.forexSourceText({ source: 'OANDA', live: true, providers: { SAXO: { name: 'Saxo', status: 'ok' }, FBS: { name: 'FBS', status: 'unavailable' } } }), /cross-check Saxo/);
  assert.doesNotMatch(fxLive.forexSourceText({ source: 'OANDA', live: true, providers: { FBS: { name: 'FBS', status: 'unavailable' } } }), /cross-check/);
  assert.equal(fxLive.forexSourceText(null), '');
  assert.doesNotMatch(fxLive.forexSourceText({ source: 'x', live: true, generatedAt: 'not-a-date' }), /diambil/);
}

// The live pull must never take the board down: failures back off, the file stays.
const liveLoaderFn = source.slice(source.indexOf('async function loadForexLive'), source.indexOf('async function loadForex('));
assert.ok(liveLoaderFn.includes('text/plain;charset=UTF-8'), 'scanner needs a simple request, application/json would trip CORS preflight');
assert.ok(/headers: \{ 'content-type': 'text\/plain;charset=UTF-8' \}/.test(liveLoaderFn), 'content-type must be the only request header');
assert.ok(!/['"](user-agent|origin|referer)['"]/.test(liveLoaderFn), 'forbidden browser headers must not appear in the scanner call');
assert.match(liveLoaderFn, /cache: 'no-store'/);

// Wiring: two consecutive pulls of a moving price must reach the board as a pip delta.
const applyFx = new Function(`
  let FOREX_QUOTES = {}, FOREX_RATES = {}, FOREX_META = {}, FOREX_TICK = {}, FOREX_LIVE = false;
  let renders = 0;
  const render = () => { renders++; };
  const recordLiveTick = () => {};
  ${extractFunction('forexTicks')}
  ${extractFunction('applyForexPayload')}
  return payload => {
    const ok = applyForexPayload(payload, '', true);
    return { ok, tick: FOREX_TICK, meta: FOREX_META, live: FOREX_LIVE, renders };
  };
`)();
{
  const first = applyFx({ quotes: { 'EUR/USD': { price: 1.12524, source: 'OANDA' } }, rates: { USD: 1 }, source: 'OANDA (live scanner)' });
  assert.equal(first.ok, true);
  assert.deepEqual(first.tick, {}, 'no delta before a previous price exists');
  assert.equal(first.live, true);
  assert.equal(first.meta.live, true);
  assert.equal(first.renders, 1);

  const second = applyFx({ quotes: { 'EUR/USD': { price: 1.12532, source: 'OANDA' } }, rates: { USD: 1 }, source: 'OANDA (live scanner)' });
  assert.equal(second.tick['EUR/USD'].dir, 'up');
  assert.ok(Math.abs(second.tick['EUR/USD'].pip - 0.8) < 1e-3);
  assert.equal(second.renders, 2);

  assert.equal(applyFx(null).ok, false, 'a broken payload keeps the last good quotes');
  assert.equal(applyFx({ quotes: {}, rates: {} }).ok, false);
  assert.equal(applyFx({ rates: { EUR: 0.92 } }).ok, true, 'a rates-only fallback still renders');
}

console.log('Passed live forex quote tests');



// ---------------------------------------------------------------------------
// Post-news confirmation rules: 15-minute settle, reaction-first direction,
// price-over-Actual conflict, locked entry levels, and index event mapping.
// ---------------------------------------------------------------------------
function buildEngine(price, { reaction = null, preNews = {}, indexRates = {}, store = { getItem: () => null, setItem: () => {} } } = {}) {
  const body = `
    const SIGNAL_LOCK_PREFIX = 'feriha:signal:v2:';
    const MOMENTUM_WINDOW_MS = 90 * 60 * 1000;
    const REACTION_MAX_AGE_MS = 45 * 60 * 1000;
    const NEWS_SETTLE_MS = 15 * 60 * 1000;
    const REACTION = ${JSON.stringify(reaction)};
    const PRE_NEWS = ${JSON.stringify(preNews)};
    let LIVE_PRICE = ${JSON.stringify(price)};
    const CRYPTO_RATES = {};
    const INDEX_RATES = ${JSON.stringify(indexRates)};
    const FOREX_RATES = {};
    const FOREX_QUOTES = {};
    ${riskSensitiveConst}
    ${rateDrivenConst}
    ${numFn}
    ${countryFn}
    ${biasFn}
    ${analyzeFn}
    ${dateEventKeyFn}
    ${eventKeyFn}
    ${normalizeSnapshotFn}
    ${preNewsSnapshotFn}
    ${preNewsPriceFn}
    ${pairRateFromFn}
    ${pairRateFn}
    ${moveNoteFn}
    ${barsOfFn}
    ${barBaseBeforeFn}
    ${reactionFromBarsClientFn}
    ${preReleaseAtrPctFn}
    ${reactionForFn}
    ${momentumForFn}
    ${forecastBiasFn}
    ${preNewsBiasFn}
    ${invertDirFn}
    ${mapPairBiasFn}
    ${indexRateFn}
    ${momentumFloorFn}
    ${reactionFloorFn}
    ${mapAssetBiasFn}
    ${mapActualBiasFn}
    ${newsPhaseFn}
    ${core}
    ${signalDirectionCoreFn}
    ${applyMarketContextFn}
    ${signalDirectionFn}
    ${signalLockKeyFn}
    ${readSignalLockFn}
    ${writeSignalLockFn}
    ${assetPriceFn}
    ${clampNumFn}
    ${spreadConst}
    const MARKETS = null;
    const LIVE_BARS = {};
    ${marketsFreshFn}
    ${barsOfFn}
    ${assetBarsFn}
    ${atrInfoFn}
    ${structureStopDistanceFn}
    ${halfSpreadEstimateFn}
    ${execEntriesFn}
    function brokerQuoteFor() { return null; }
    ${computeSignalLevelsFn}
    ${levelsFromLockFn}
    ${missedFromLevelsFn}
    ${resolveSignalLevelsFn}
    ${signalCardDataFn}
    return { signalDirection, signalCardData, resolveSignalLevels, setPrice: p => { LIVE_PRICE = p; } };
  `;
  return new Function('localStorage', body)(store);
}

function memoryStore() {
  return {
    data: {},
    getItem(k) { return this.data[k] || null; },
    setItem(k, v) { this.data[k] = v; }
  };
}

{
  const now = Date.now();
  const released = mins => ({
    Date: new Date(now - mins * 60 * 1000).toISOString(),
    Event: 'CPI', Country: 'USD', Importance: 3, Forecast: '3.0%', Previous: '2.9%', Actual: '3.2%'
  });

  // 15-minute settle: the first spike is live, not tradable.
  const settling = buildEngine(4000).signalDirection(released(14), 'XAU/USD', 'gold', now);
  assert.equal(settling.phase, 'live');
  assert.equal(settling.dir, null);
  assert.equal(settling.basis, 'settling');
  const confirmed = buildEngine(4000).signalDirection(released(16), 'XAU/USD', 'gold', now);
  assert.equal(confirmed.phase, 'post');

  // Reaction beats Actual. Actual says USD-strong (gold short) but price is up:
  // the signal follows the price and records the conflict instead of fighting it.
  const conflictEvent = released(30);
  const conflictReaction = {
    generatedAt: new Date(now).toISOString(),
    events: {
      [`${conflictEvent.Date}|CPI`]: {
        pairs: { 'XAU/USD': { movePct: 0.4, dir: 'long', minutes: 30 } }
      }
    }
  };
  const byReaction = buildEngine(4000, { reaction: conflictReaction })
    .signalDirection(conflictEvent, 'XAU/USD', 'gold', now);
  assert.equal(byReaction.basis, 'reaction');
  assert.equal(byReaction.dir, 'long');
  assert.equal(byReaction.conflict, true);
  assert.match(byReaction.note, /berlawanan dengan Actual/);

  // A reaction below the noise floor is ignored, so Actual remains the fallback.
  const noiseReaction = {
    generatedAt: new Date(now).toISOString(),
    events: {
      [`${conflictEvent.Date}|CPI`]: {
        pairs: { 'XAU/USD': { movePct: 0.05, dir: 'long', minutes: 30 } }
      }
    }
  };
  const byActual = buildEngine(4000, { reaction: noiseReaction })
    .signalDirection(conflictEvent, 'XAU/USD', 'gold', now);
  assert.equal(byActual.basis, 'actual');
  assert.equal(byActual.dir, 'short');

  // Once confirmed, Entry/SL/TP are locked and cannot repaint on every tick.
  const store = memoryStore();
  const engine = buildEngine(4000, { store });
  const first = engine.signalCardData(conflictEvent, 'XAU/USD', 'gold', now);
  assert.ok(first.locked, 'post-news levels must be locked');
  assert.equal(first.levels.entry, 3999.85);
  engine.setPrice(3900);
  const second = engine.signalCardData(conflictEvent, 'XAU/USD', 'gold', now);
  assert.equal(second.levels.entry, first.levels.entry, 'locked entry must not repaint');
  assert.equal(second.levels.sl, first.levels.sl, 'locked SL must not repaint');
  assert.equal(second.levels.tp, first.levels.tp, 'locked TP must not repaint');
  assert.ok(second.missed, 'price that ran away from the locked entry must be flagged');

  // Direction conflicts keep the old order and warn instead of flipping.
  const lockEvent = { ...conflictEvent, Event: 'Retail Sales' };
  const armedStore = memoryStore();
  const lockKey = `feriha:signal:v2:${lockEvent.Date}|Retail Sales|XAU/USD`;
  armedStore.data[lockKey] = JSON.stringify({
    dir: 'long', entry: 4000, sl: 4028.6, tp: 3942.8,
    phase: 'post', basis: 'momentum', at: new Date(now).toISOString()
  });
  const lockReaction = {
    generatedAt: new Date(now).toISOString(),
    events: {
      [`${lockEvent.Date}|Retail Sales`]: {
        pairs: { 'XAU/USD': { movePct: -0.4, dir: 'short', minutes: 30 } }
      }
    }
  };
  const flip = buildEngine(4000, { store: armedStore, reaction: lockReaction })
    .signalCardData(lockEvent, 'XAU/USD', 'gold', now);
  assert.equal(flip.dir, 'long', 'locked direction must not flip to chase price');
  assert.equal(flip.conflict, true);
  assert.equal(flip.levels.entry, 4000);

  // After the momentum/Actual window closes, the confirmed signal stays until expiry
  // instead of disappearing mid-trade.
  const oldEvent = { ...conflictEvent, Date: new Date(now - 4 * 60 * 60 * 1000).toISOString() };
  const heldStore = memoryStore();
  heldStore.data[`feriha:signal:v2:${oldEvent.Date}|CPI|XAU/USD`] = JSON.stringify({
    dir: 'short', entry: 4000, sl: 4028.6, tp: 3942.8,
    phase: 'post', basis: 'reaction', at: new Date(now - 3.5 * 60 * 60 * 1000).toISOString()
  });
  const held = buildEngine(3900, { store: heldStore }).signalCardData(oldEvent, 'XAU/USD', 'gold', now);
  assert.equal(held.dir, 'short', 'confirmed signal must outlive the 3-hour Actual window');
  assert.equal(held.carried, true);
  assert.equal(held.levels.entry, 4000);
  assert.ok(held.missed);

  // Index mapping is event-aware: strong payrolls lift indices (risk-on) while a
  // hot CPI still pressures them (rate risk).
  const nfp = {
    Date: new Date(now - 30 * 60 * 1000).toISOString(),
    Event: 'Nonfarm Payrolls', Country: 'USD', Importance: 3,
    Forecast: '100K', Previous: '90K', Actual: '250K'
  };
  const cpi = { ...nfp, Event: 'CPI' };
  const idxRates = { US500: { price: 5800, changePct: 0.8 } };
  const nfpSig = buildEngine(5800, { indexRates: idxRates }).signalDirection(nfp, 'US500', 'index', now);
  assert.equal(nfpSig.dir, null, 'NFP is regime-dependent on indices (rate vs growth), so direction is not forced');
  const cpiSig = buildEngine(5800, { indexRates: idxRates }).signalDirection(cpi, 'US500', 'index', now);
  assert.equal(cpiSig.dir, 'short', 'hot CPI stays a headwind for indices');
}


// During the 15-minute confirmation window no board publishes entry levels.
{
  const levels = { entry: 100, sl: 98, tp: 104, rr: 2 };
  const liveCrypto = cryptoBoardHtml({}, {}, {
    status: 'live', phase: 'post', event: 'CPI', items: [
      { pair: 'BTC/USD', name: 'Bitcoin', slPct: 1, tpPct: 2, price: 65000, changePct: 1, dir: 'long', levels }
    ]
  });
  assert.match(liveCrypto, /Level entry ditahan sampai konfirmasi 15 menit/);
  assert.doesNotMatch(liveCrypto, /Entry 65,000/);

  const liveIndex = indicesBoardHtml({
    status: 'live', phase: 'post', event: 'CPI', items: [
      { symbol: 'US500', name: 'S&P 500', slPct: 0.75, tpPct: 1.5, price: 5800, changePct: 0.8, dir: 'long', levels }
    ]
  });
  assert.match(liveIndex, /Level entry ditahan sampai konfirmasi 15 menit/);
  assert.doesNotMatch(liveIndex, /Entry 5,800/);

  const liveForex = forexBoardHtml({ items: [
    { pair: 'EUR/USD', rate: 1.1, dir: 'long', phase: 'live', levels: { entry: 1.1, sl: 1.098, tp: 1.104, rr: 2 } }
  ] });
  assert.match(liveForex, /Tunggu konfirmasi 15 menit/);
  assert.doesNotMatch(liveForex, /Entry 1\.10000/);
}

// ---------------------------------------------------------------------------
// Sentiment calibration: consumer / sentiment-style indices share the same
// significance rules as PMI and are allowed to drive a post-news forex entry.
// ---------------------------------------------------------------------------
{
  // A flat sentiment print is flat: no edge, no synthetic confidence.
  const sentFlat = analyze({ Event: 'University of Michigan Consumer Sentiment Index', Country: 'USA', Actual: '70.0', Forecast: '70.0' });
  assert.equal(sentFlat.dir, 'wait');
  assert.equal(sentFlat.basis, 'flat');
  assert.equal(sentFlat.score, 45);

  // A released sentiment index with a real surprise resolves a post-news forex
  // entry: stronger (weaker USD) than expected -> EUR/USD BUY, USD/JPY SELL.
  const sentEvent = {
    Date: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
    Event: 'University of Michigan Consumer Sentiment Index', Country: 'USA', Importance: 2,
    Forecast: '71.0', Previous: '69.0', Actual: '68.5'
  };
  const sentSig = buildEngine(4000).signalDirection(sentEvent, 'EUR/USD', 'forex', Date.now());
  assert.equal(sentSig.phase, 'post');
  assert.equal(sentSig.basis, 'actual');
  assert.equal(sentSig.dir, 'long');
  const sentJpy = buildEngine(150).signalDirection(sentEvent, 'USD/JPY', 'forex', Date.now());
  assert.equal(sentJpy.dir, 'short');

  const sentCci = buildEngine(4000).signalDirection({
    ...sentEvent, Event: 'Conference Board Consumer Confidence', Actual: '67.0'
  }, 'EUR/USD', 'forex', Date.now());
  assert.equal(sentCci.basis, 'actual');
  assert.equal(sentCci.dir, 'long');
}

// ---------------------------------------------------------------------------
// Threshold unification: the pre-news bias and the post-news analysis must use
// the same flat threshold, so a release cannot flip between "flat" and "significant".
// ---------------------------------------------------------------------------
{
  const gdpFlatForecast = forecastBias({ Event: 'GDP', Country: 'USA', Forecast: '27.0', Previous: '27.0' });
  assert.equal(gdpFlatForecast, null, 'flat GDP forecast -> no pre-news edge');
  const gdpFlatActual = analyze({ Event: 'GDP', Country: 'USA', Actual: '27.0', Forecast: '27.0' });
  assert.equal(gdpFlatActual.dir, 'wait');
  assert.equal(gdpFlatActual.basis, 'flat');
  assert.equal(gdpFlatActual.score, 45);

  const gdpUp = forecastBias({ Event: 'GDP', Country: 'USA', Forecast: '27.5', Previous: '27.0' });
  assert.equal(gdpUp.dir, 'short');
  assert.ok(gdpUp.surprise > 0);
}

console.log('Passed post-news confirmation and lock tests');
