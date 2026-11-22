import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseTreasuryYieldCsv,
  zScore,
  inflationFromEvents,
  scoreGoldDrivers,
  goldDriverLabel,
  fetchYahooDaily,
  fetchIauSharesOutstanding
} from '../scripts/fetch-calendar.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const TREASURY_CSV = [
  'Date,"5 YR","7 YR","10 YR","20 YR","30 YR"',
  '11/20/2026,2.53,2.64,2.77,3.03,3.17',
  '11/17/2026,2.64,2.76,2.59,3.14,3.28',
  '11/13/2026,2.68,2.78,2.41,3.15,3.38'
].join('\n');

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
    encodeURIComponent, decodeURIComponent, isFinite: Number.isFinite, isNaN: Number.isNaN,
    setTimeout: noop, clearTimeout: noop, setInterval: () => 1, clearInterval: noop,
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
  return { ctx, elements, store };
}

function setSentimentCache(ctx, value) {
  vm.runInContext(`SENTIMENT_CACHE = ${JSON.stringify(value)};`, ctx);
}

test('parseTreasuryYieldCsv membaca yield real 10Y Treasury dari CSV', () => {
  const t = parseTreasuryYieldCsv(TREASURY_CSV);
  assert.ok(t, 'yield CSV Treasury harus terbaca');
  assert.equal(t.value, 2.77);
  assert.equal(t.date, '2026-11-20');
  assert.equal(t.change1d, 0.18);
  assert.ok(Array.isArray(t.series) && t.series.length >= 2, 'series yield harus terisi');
  assert.ok(t.series.every((v, i, a) => i === 0 || a[i - 1] <= v), 'series yield harus urut naik (terlama -> terbaru)');
});

test('zScore menghitung posisi relatif nilai terakhir terhadap tren data', () => {
  assert.equal(zScore([2, 2, 2, 2, 2, 2, 2, 2]), 0);
  assert.ok(Number.isFinite(zScore([1, 1, 1, 1, 1, 5, 5, 5, 5, 5])));
  assert.equal(zScore([1, 2, 3]), null);
});

test('inflationFromEvents mengekstrak kejutan CPI/PCE terbaru dari kalender rilis', () => {
  const now = Date.parse('2026-11-20T00:00:00Z');
  const events = [
    { Date: '2026-11-12T13:30:00Z', Event: 'Core CPI m/m', Country: 'United States', Importance: 3, Actual: '0.3%', Forecast: '0.2%' },
    { Date: '2026-10-29T12:30:00Z', Event: 'PCE Price Index MoM', Country: 'United States', Importance: 3, Actual: '0.5%', Forecast: '0.5%' },
    { Date: '2026-11-01T12:30:00Z', Event: 'Core PCE Price Index m/m', Country: 'United States', Importance: 3, Actual: '0.2%', Forecast: '0.2%' },
    { Date: '2026-11-05T00:00:00Z', Event: 'China PMI', Country: 'China', Importance: 3, Actual: '9.9', Forecast: '9.0%' }
  ];
  const inf = inflationFromEvents(events, now);
  assert.equal(inf.latest.event, 'Core CPI m/m');
  assert.equal(inf.latest.surprise, 0.1);
  assert.equal(inf.cpi.event, 'Core CPI m/m');
  assert.equal(inf.pce.event, 'Core PCE Price Index m/m');
});

test('scoreGoldDrivers & label mengkalibrasi skor beari/bulli/netral dari data driver', () => {
  const bullish = scoreGoldDrivers({
    yield: { zNominal: -1.2, zReal: -1.0 },
    dxy: { z: -1.0 },
    fed: { z: -0.8, inflation: { surprise: -0.2, forecast: 0.3 } },
    flows: { flowScore: 55, basis5d: 0.3, volumeRatio: 1.5, etfChange1d: 2 }
  });
  assert.equal(bullish.missing.length, 0);
  assert.ok(bullish.score > 0, 'konflik semuanya mendukung emas harus Bullish');

  const bearish = scoreGoldDrivers({
    yield: { zNominal: 1.5, zReal: 1.2 },
    dxy: { z: 1.0 },
    fed: { z: 0.9, inflation: { surprise: 0.1, forecast: 0.3 } },
    flows: { flowScore: -30, basis5d: -0.2, volumeRatio: 0.7, etfChange1d: -3 }
  });
  assert.equal(bearish.missing.length, 0);
  assert.ok(bearish.score < 0, 'konflik semuanya menekan emas harus Bearish');

  const empty = scoreGoldDrivers(null);
  assert.equal(empty.score, null);
  assert.equal(goldDriverLabel(null), 'Belum ada data');
});

test('fetchYahooDaily mem-parse seri harian & perubahan harga dari payload Yahoo', async () => {
  const fixture = {
    chart: {
      result: [{
        meta: { regularMarketPrice: 3992, chartPreviousClose: 3991 },
        timestamp: [1790000000, 1790086400, 1790172800],
        indicators: { quote: [{ open: [3990, 3989, 3991], high: [3992, 3990, 3992], low: [3988, 3988, 3989], close: [3991, 3988, 3992], volume: [1000, 900, 1100] }] }
      }]
    }
  };
  const res = await fetchYahooDaily('GC=F', { fetchImpl: async () => ({ ok: true, json: async () => fixture }) });
  assert.equal(res.last, 3992);
  assert.equal(res.closes.length, 3);
  assert.equal(res.closes[0], 3991);
  assert.equal(res.closes[2], 3992);
  assert.ok(res.change1d > 0, 'perubahan close hari ini harus positif');
  assert.ok(Math.abs(res.absChange1d - 4) < 1e-6, 'absChange1d harus beda absolut close hari ini');
});

test('fetchIauSharesOutstanding mengembalikan unit beredar resmi dari halaman iShares', async () => {
  const fixture = '<div>"label":"Shares Outstanding","formattedValue":"1,160,150,000","sortOrder":46,"prefix":null,"infoBubble":"","formattedAsOfDate":"Nov 20, 2026"</div>';
  const res = await fetchIauSharesOutstanding({ fetchImpl: async () => ({ ok: true, text: async () => fixture }) });
  assert.ok(res);
  assert.equal(res.shares, 1160150000);
  assert.equal(res.asOf, 'Nov 20, 2026');
});

test('renderMacroBoard menampilkan 5 kartu penggerak emas + kartu komposit', () => {
  const { ctx, elements } = createDashboardSandbox();
  const cache = {
    generatedAt: '2026-11-20T13:43:17.078Z',
    cnn: { score: 12, rating: 'Extreme Fear' },
    crypto: { score: 12, rating: 'Extreme Fear' },
    drivers: {
      yield: { tenYr: 4.91, realTenYr: 2.77, zNominal: -0.8, zReal: 0.37, change1d: -0.14, date: '2026-11-20' },
      dxy: { price: 103.81, change1d: -0.09, change5d: 0.39, z: 1.5, date: '2026-11-20' },
      fed: { impliedRate: 4.12, change1d: -0.02, z: 0.96, inflation: { latest: { event: 'Core CPI m/m', actual: 0.3, forecast: 0.2, surprise: 0.1 } } },
      flows: { etfChange1d: -3.65, etfChange5d: -9.15, spotChange5d: -9.54, basis5d: 0.4, volumeRatio: 2.39, flowScore: -23 }
    },
    goldDrivers: { score: -23, label: 'Bearish', parts: { yield: 8, dxy: -51, fed: -32, flows: -23 }, weights: { yield: 0.3, dxy: 0.25, fed: 0.25, flows: 0.2 }, missing: [] }
  };
  setSentimentCache(ctx, cache);
  vm.runInContext('renderMacroBoard();', ctx);
  const html = elements.get('#macroBody').innerHTML;
  assert.ok(html.includes('Penggerak Emas'), 'kartu komposit penggerak emas harus ada');
  assert.ok(html.includes('Real Yield'), 'kartu faktor 1 harus ada');
  assert.ok(html.includes('DXY'), 'kartu faktor 2 harus ada');
  assert.ok(html.includes('Kebijakan Fed'), 'kartu faktor 3 harus ada');
  assert.ok(html.includes('Bank Sentral'), 'kartu faktor 4 harus ada');
  assert.ok(html.includes('Bearish'), 'skor komposit harus tampil');
  assert.equal((html.match(/macro-card/g) || []).length, 11, 'harus render 11 kartu makro (6 lama + 5 penggerak)');
});

test('renderMacroBoard menampilkan placeholder saat belum ada data driver', () => {
  const { ctx, elements } = createDashboardSandbox();
  vm.runInContext('renderMacroBoard();', ctx);
  const html = elements.get('#macroBody').innerHTML;
  assert.ok(html.includes('Penggerak Emas'));
  assert.ok(html.includes('Menunggu data yield/DXY/Fed/ETF dari feed publik…'));
});
