// Jalankan: node test-signal-logic.mjs
// Mengekstrak fungsi murni langsung dari index.html (tanpa duplikasi kode) dan
// menguji logika kalibrasi memakai data nyata calendar.json.
import fs from 'node:fs';
import assert from 'node:assert/strict';

const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const calPath = ['./data/calendar.json', './calendar.json'].map(p => new URL(p, import.meta.url)).find(u => fs.existsSync(u));
if (!calPath) throw new Error('calendar.json tidak ditemukan (taruh di ./data/ atau di folder yang sama)');
const calendar = JSON.parse(fs.readFileSync(calPath, 'utf8'));

function extractFn(src, name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error('fungsi tidak ditemukan: ' + name);
  let depth = 0, started = false;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') { depth++; started = true; }
    else if (src[k] === '}') { depth--; if (started && depth === 0) return src.slice(i, k + 1); }
  }
  throw new Error('kurung tidak seimbang: ' + name);
}
function extractConst(src, name) {
  const m = src.match(new RegExp(`const ${name} = [\\s\\S]*?;\\n`));
  if (!m) throw new Error('const tidak ditemukan: ' + name);
  return m[0];
}
const core = html.slice(html.indexOf('// BEGIN CALIBRATION CORE'), html.indexOf('// END CALIBRATION CORE'));
const code = [
  extractFn(html, 'num'), extractFn(html, 'countryCode'),
  core,
  extractFn(html, 'invertDir'), extractFn(html, 'mapPairBias'),
  extractConst(html, 'RATE_DRIVEN_EVENT'), extractFn(html, 'mapAssetBias'),
  extractFn(html, 'goldBias'), extractFn(html, 'detectICT'),
  'return { usdSign, surpriseCalc, combinedZ, dirFromZ, contextAlignment, mapPairBias, mapAssetBias, goldBias, detectICT, num };'
].join('\n');
const L = new Function(code)();

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n      ', e.message); process.exitCode = 1; } };
const ev = (name) => calendar.find(x => x.Event === name && x.Country === 'USD');

console.log('Polaritas & pemetaan');
t('Core CPI / CPI / NFP hawkish (+1)', () => { for (const n of ['Core CPI m/m', 'CPI m/m', 'Nonfarm Payrolls', 'ISM Services PMI']) assert.equal(L.usdSign(n), 1, n); });
t('Unemployment / Claims dovish bila naik (-1)', () => { for (const n of ['Unemployment Rate', 'Unemployment Claims', 'Jobless Claims']) assert.equal(L.usdSign(n), -1, n); });
t('Event noise TIDAK dipetakan (sebelumnya menghasilkan sinyal emas)', () => {
  for (const n of ['Crude Oil Inventories', 'Natural Gas Storage', 'Federal Budget Balance', 'Final Wholesale Inventories m/m', 'FOMC Member Waller Speaks'])
    assert.equal(L.usdSign(n), null, n);
});
t('"ism"/"ppi" tidak salah cocok di dalam kata lain', () => { assert.equal(L.usdSign('Shopping Mechanism Index'), null); });

console.log('Surprise & threshold (data calendar.json 10 Nov)');
t('Core CPI 0.3 vs 0.2 = surprise nyata (float 0.0999… tidak jadi FLAT)', () => {
  const e = ev('Core CPI m/m');
  assert.equal(L.surpriseCalc('core cpi m/m', L.num(e.Actual), L.num(e.Forecast)).flat, false);
});
t('NFP 15K di bawah noise = FLAT, 45K = nyata', () => {
  assert.equal(L.surpriseCalc('nonfarm payrolls', 135000, 120000).flat, true);
  assert.equal(L.surpriseCalc('nonfarm payrolls', 165000, 120000).flat, false);
});
t('Claims 197K vs 194K FLAT; 210K vs 194K nyata', () => {
  assert.equal(L.surpriseCalc('unemployment claims', 197000, 194000).flat, true);
  assert.equal(L.surpriseCalc('unemployment claims', 210000, 194000).flat, false);
});

console.log('Paket rilis & arah');
t('CPI + Core CPI 10 Nov dinilai satu paket → hawkish → bias SELL emas', () => {
  const e = ev('CPI m/m');
  const pack = L.combinedZ(e, calendar);
  assert.ok(pack.parts.length === 2, 'harus gabung 2 rilis, dapat ' + pack.parts.length);
  assert.ok(pack.z > 0.6, 'z=' + pack.z);
  assert.equal(L.dirFromZ(pack.z, 'USD'), 'short');
});
t('Paket campur (CPI panas, Core CPI dingin) → z kecil → WAIT', () => {
  const pool = [
    { Date: 'D', Event: 'CPI m/m', Country: 'USD', Forecast: '0.3%', Actual: '0.4%' },
    { Date: 'D', Event: 'Core CPI m/m', Country: 'USD', Forecast: '0.3%', Actual: '0.2%' }
  ];
  assert.ok(Math.abs(L.combinedZ(pool[0], pool).z) < 0.6);
});
t('Claims lebih tinggi dari Forecast → USD lemah → emas BUY', () => {
  const e = { Date: 'D', Event: 'Unemployment Claims', Country: 'USD', Forecast: '194K', Actual: '215K' };
  assert.equal(L.dirFromZ(L.combinedZ(e, [e]).z, 'USD'), 'long');
});
t('goldBias konsisten dengan arah z', () => {
  assert.equal(L.goldBias('cpi m/m', 0.2, 'USD'), false);   // CPI panas → emas turun
  assert.equal(L.goldBias('unemployment rate', 0.2, 'USD'), true);
  assert.equal(L.goldBias('gdp q/q', 0.4, 'GBP'), true);    // GBP kuat → pair 'long'
});

console.log('Pemetaan antar-aset');
t('Cross GBP/JPY tidak mendapat arah dari event USD', () => { assert.equal(L.mapPairBias('GBP/JPY', 'long', 'USD'), null); });
t('USD/JPY & EUR/USD tetap dipetakan benar untuk event USD', () => {
  assert.equal(L.mapPairBias('USD/JPY', 'long', 'USD'), 'short');   // USD lemah → USD/JPY turun
  assert.equal(L.mapPairBias('EUR/USD', 'long', 'USD'), 'long');
});
t('Indeks/crypto: inflasi dipetakan, NFP/claims TIDAK (bergantung rezim)', () => {
  assert.equal(L.mapAssetBias('index', 'NAS100', 'short', { Event: 'CPI m/m' }), 'short');
  assert.equal(L.mapAssetBias('index', 'NAS100', 'short', { Event: 'Nonfarm Payrolls' }), null);
  assert.equal(L.mapAssetBias('crypto', 'BTC/USD', 'long', { Event: 'Unemployment Claims' }), null);
});

console.log('Kalibrasi sentimen');
t('Emas BUY + extreme fear = selaras; SELL + extreme fear = melawan', () => {
  assert.equal(L.contextAlignment({ kind: 'gold', asset: 'XAU/USD', dir: 'long', fg: 15 }).align, 'with');
  assert.equal(L.contextAlignment({ kind: 'gold', asset: 'XAU/USD', dir: 'short', fg: 15 }).align, 'against');
});
t('Emas SELL melawan fear + USD melemah → size 0.25×', () => {
  const c = L.contextAlignment({ kind: 'gold', asset: 'XAU/USD', dir: 'short', fg: 15, usdChgPct: -0.4 });
  assert.equal(c.size, 0.25);
});
t('BTC BUY di extreme greed = melawan (crowded)', () => {
  assert.equal(L.contextAlignment({ kind: 'crypto', asset: 'BTC/USD', dir: 'long', fg: 50, cryptoFg: 88 }).align, 'against');
});
t('Forex: EUR/USD BUY saat DXY naik 0.4% = berlawanan', () => {
  assert.equal(L.contextAlignment({ kind: 'forex', asset: 'EUR/USD', dir: 'long', usdChgPct: 0.4 }).align, 'against');
});
t('Tanpa data sentimen = netral, ukuran penuh', () => {
  const c = L.contextAlignment({ kind: 'gold', asset: 'XAU/USD', dir: 'long' });
  assert.deepEqual([c.align, c.size], ['neutral', 1]);
});

console.log('Deteksi ICT (bug label terbalik)');
const bar = (o, h, l, c) => ({ o, h, l, c });
const flat = n => Array.from({ length: n }, () => bar(100, 100.5, 99.5, 100));
t('Gap naik (high#1 < low#3) = Bullish FVG', () => {
  const bars = [...flat(30), bar(100, 100.4, 99.8, 100.3), bar(100.3, 102, 100.3, 101.9), bar(101.9, 102.5, 101.5, 102.4), bar(102.4, 102.6, 102.2, 102.5)]; // +1 candle berjalan (triplet terakhir memang dilewati)
  const tags = L.detectICT(bars).filter(x => /FVG/.test(x.tag));
  assert.ok(tags.length && /Bullish FVG/.test(tags[0].tag) && tags[0].dir === 'buy', JSON.stringify(tags));
});
t('Gap turun = Bearish FVG', () => {
  const bars = [...flat(30), bar(100, 100.2, 99.6, 99.7), bar(99.7, 99.8, 98, 98.1), bar(98.1, 98.5, 97.5, 97.6), bar(97.6, 97.8, 97.3, 97.5)]; // +1 candle berjalan
  const tags = L.detectICT(bars).filter(x => /FVG/.test(x.tag));
  assert.ok(tags.length && /Bearish FVG/.test(tags[0].tag) && tags[0].dir === 'sell', JSON.stringify(tags));
});
t('Leg naik lalu pullback 0.7 → OTE bullish (BUY), bukan bearish', () => {
  const bars = [];
  for (let i = 0; i < 10; i++) bars.push(bar(100, 100.2, 99.8, 100));
  for (let i = 0; i < 15; i++) { const p = 100 + (i + 1) * 2; bars.push(bar(p - 2, p + 0.2, p - 2.2, p)); }   // naik ke 130
  for (let i = 0; i < 15; i++) { const p = 130 - (i + 1) * 1.4; bars.push(bar(p + 1.4, p + 1.6, p - 0.2, p)); } // turun ke ~109
  const ote = L.detectICT(bars).filter(x => /OTE/.test(x.tag));
  assert.ok(ote.length, 'OTE tidak terdeteksi');
  assert.ok(ote.every(x => /bullish/.test(x.tag) && x.dir === 'buy'), JSON.stringify(ote));
});

console.log('Reaksi harga (fetch-calendar.mjs)');
const { reactionFromBars } = await import('./fetch-calendar.mjs');
t('Basis = close SEBELUM menit rilis, bukan bar yang sudah memuat spike', () => {
  const releaseMs = Date.UTC(2026, 10, 10, 13, 30);          // 08:30 EST
  const k0 = releaseMs / 60000;
  const bars = [];
  for (let m = -30; m <= 50; m++) {
    let c = 4100;
    if (m >= 0) c = 4100 + Math.min(m, 3) * 5;                // spike +15 dalam 3 menit
    if (m >= 20) c = 4118;                                    // bertahan naik
    bars.push({ k: k0 + m, o: c, h: c, l: c, c });
  }
  const r = reactionFromBars(bars, releaseMs);
  assert.equal(r.baseClose, 4100);
  assert.equal(r.dir, 'long');
  assert.equal(r.faded, false);
});
t('Spike naik lalu berbalik turun ditandai faded', () => {
  const releaseMs = Date.UTC(2026, 10, 10, 13, 30), k0 = releaseMs / 60000, bars = [];
  for (let m = -30; m <= 50; m++) {
    let c = 4100;
    if (m >= 0 && m < 10) c = 4100 + Math.min(m, 3) * 6;
    if (m >= 10) c = 4100 - 8;
    bars.push({ k: k0 + m, o: c, h: c, l: c, c });
  }
  const r = reactionFromBars(bars, releaseMs);
  assert.equal(r.dir, 'short');
  assert.equal(r.faded, true);
});

console.log(`\n${pass} tes lulus${process.exitCode ? ' — ADA YANG GAGAL' : ''}`);
