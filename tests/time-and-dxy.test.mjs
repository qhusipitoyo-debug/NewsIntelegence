import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const core = html.slice(html.indexOf('// BEGIN CALIBRATION CORE'), html.indexOf('// END CALIBRATION CORE'));

function extractFn(src, name) {
  const i = src.indexOf(`function ${name}(`);
  assert.notEqual(i, -1, name + ' tidak ditemukan');
  const open = src.indexOf('{', i);
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (!depth) return src.slice(i, k + 1); }
  }
  throw new Error('kurung tidak seimbang: ' + name);
}
function extractConst(src, name) {
  const m = src.match(new RegExp(`const ${name} = [\\s\\S]*?;\\n`));
  assert.ok(m, name + ' tidak ditemukan');
  return m[0];
}

test('usdSign: lower-is-better dibalik, FIRM hawkish, employment tidak salah cocok', () => {
  const L = new Function([
    extractConst(html, 'SOFT_IF_HIGH'), extractConst(html, 'FIRM_IF_HIGH'),
    extractFn(html, 'usdSign'), 'return { usdSign };'
  ].join('\n'))();
  for (const n of ['Unemployment Rate', 'Initial Jobless Claims', 'Continuing Claims', 'Claimant Count Change', 'Challenger Job Cuts'])
    assert.equal(L.usdSign(n), -1, n);
  for (const n of ['CPI m/m', 'Core CPI m/m', 'PCE Price Index', 'FOMC Rate Decision', 'Nonfarm Payrolls', 'Retail Sales', 'S&P Global PMI', 'Employment Change'])
    assert.equal(L.usdSign(n), 1, n);
  assert.equal(L.usdSign('Crude Oil Inventories'), null);
});

test('DXY sintetis: EUR/USD & GBP/USD di-inverse, pair USD/ tidak', () => {
  const L = new Function([
    extractConst(html, 'USD_WEIGHTS'),
    'let FOREX_QUOTES = {};',
    extractFn(html, 'usdBias'),
    'return { USD_WEIGHTS, usdBias, set: q => { FOREX_QUOTES = q; } };'
  ].join('\n'))();
  const w = Object.values(L.USD_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(w - 1) < 1e-9, 'bobot harus dinormalisasi');
  // EUR turun 0.5 & GBP turun 0.4 -> USD naik; USD/JPY naik 0.3 ikut kuatkan USD.
  L.set({
    'EUR/USD': { changePct: -0.5 }, 'GBP/USD': { changePct: -0.4 },
    'USD/JPY': { changePct: 0.3 }, 'USD/CAD': { changePct: 0.2 }, 'USD/CHF': { changePct: 0.2 }
  });
  assert.ok(L.usdBias().changePct > 0, 'DXY sintetis harus naik');
  // Balik tanda EUR saja -> DXY turun (bukti inversi bekerja).
  L.set({ 'EUR/USD': { changePct: 0.5 }, 'USD/JPY': { changePct: 0 } });
  assert.ok(L.usdBias().changePct < 0);
});

test('WITA & jendela 15 menit kebal DST AS/UK (offset IANA, bukan hardcode +8)', () => {
  const L = new Function([
    extractConst(html, 'WITA'),
    extractConst(html, 'NEWS_SETTLE_MS'),
    'const fmtTime = d => new Intl.DateTimeFormat("en-IN", { timeZone: WITA, hour: "2-digit", minute: "2-digit", hour12: false }).format(d) + " WITA";',
    extractFn(html, 'newsPhase'),
    'return { fmtTime, newsPhase, NEWS_SETTLE_MS };'
  ].join('\n'))();
  const dates = ['2026-10-30T12:30:00Z', '2026-11-02T12:30:00Z']; // sebelum & sesudah DST
  for (const d of dates) {
    const t = Date.parse(d);
    assert.match(L.fmtTime(new Date(t)), /20:30 WITA/, d);
    assert.equal(L.newsPhase({ Date: d }, t + L.NEWS_SETTLE_MS - 1000), 'live', d);
    assert.equal(L.newsPhase({ Date: d }, t + L.NEWS_SETTLE_MS + 1000), 'post', d);
  }
});
