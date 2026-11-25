import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function sandbox() {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'inline <script> block must exist');
  const els = new Map();
  const dummy = { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], style: {}, classList: { add() {}, remove() {} } };
  const makeEl = () => ({ innerHTML: '', textContent: '', style: {}, classList: { add() {}, remove() {} }, querySelectorAll: () => [] });
  for (const id of ['forecastGrid', 'macroBody', 'ipoBody']) els.set('#' + id, makeEl());
  const box = {
    document: {
      getElementById: id => els.get('#' + id) || dummy,
      querySelector: sel => els.get(sel) || dummy,
      querySelectorAll: sel => (els.get(sel) ? [els.get(sel)] : [])
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    // Promise yang tidak pernah resolve: Hindari catch() startup yang memanggil
    // render() lengkap dengan data kosong di luar konteks test ini.
    fetch: () => new Promise(() => {}),
    console: { log() {}, warn() {}, error() {} },
    setInterval: () => 1, clearInterval() {}, setTimeout() {},
    Date, Intl, Math, JSON, Number, String, Object, Array, Promise, RegExp, encodeURIComponent
  };
  box.window = box;
  const ctx = vm.createContext(box);
  vm.runInContext(match[1], ctx);
  return { ctx, els };
}

const bar = (t, c) => ({ t, o: c - 1, h: c + 2, l: c - 2, c });

test('closedOnly aggregate: partial/current W-M buckets and forex Sunday are dropped', () => {
  const { ctx } = sandbox();
  const bars = [
    bar('2026-11-16', 100), bar('2026-11-17', 101), bar('2026-11-18', 102),
    bar('2026-11-19', 103), bar('2026-11-20', 104),
    { ...bar('2026-11-22', 105), partial: true }
  ];
  const now = Date.parse('2026-11-23T01:00:00Z'); // Senin: pekan 16–20 sudah close
  const weekly = vm.runInContext(`aggregateHtfBars(${JSON.stringify(bars)}, 'weekly', { closedOnly: true, kind: 'forex', now: ${now} })`, ctx);
  assert.equal(weekly.length, 1, 'hanya satu pekan yang sudah close');
  assert.equal(weekly[0].t, '2026-W47');
  assert.equal(weekly[0].c, 104, 'close = Jumat, bukan harga Minggu yang partial');

  const monthBars = [bar('2026-10-15', 90), bar('2026-10-20', 92), ...bars];
  const monthly = vm.runInContext(`aggregateHtfBars(${JSON.stringify(monthBars)}, 'monthly', { closedOnly: true, kind: 'forex', now: ${now} })`, ctx);
  assert.equal(JSON.stringify(monthly.map(b => b.t)), JSON.stringify(['2026-10']), 'bulan berjalan (2026-11) dibuang');

  const daily = vm.runInContext(`aggregateHtfBars(${JSON.stringify(bars)}, 'daily', { closedOnly: true, kind: 'forex', now: ${now} })`, ctx);
  assert.equal(daily.length, 5, 'bar Minggu ber-flag partial tidak masuk daily');

  // Jumat 20 Nov pukul 23Z: pekan berjalan dibuang, bar hari ini juga dibuang.
  const friday = Date.parse('2026-11-20T23:00:00Z');
  const wFri = vm.runInContext(`aggregateHtfBars(${JSON.stringify(bars)}, 'weekly', { closedOnly: true, kind: 'forex', now: ${friday} })`, ctx);
  assert.equal(wFri.length, 0, 'pekan yang belum tutup tidak boleh masuk');
});

test('monthly EMA10/RSI14 ditolak bila bar kurang dari slow+15', () => {
  const { ctx } = sandbox();
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push(bar('2026-' + String(i + 1).padStart(2, '0') + '-10', 100 + i));
  const res = vm.runInContext(`htfDirection(${JSON.stringify(rows)}, 'monthly', 112, { kind: 'gold', now: ${Date.parse('2026-12-05T00:00:00Z')} })`, ctx);
  assert.equal(res.dir, 'wait');
  assert.match(res.reason, /Data monthly kurang|RSI14/);
});

test('forecastShock: spike tidak boleh menimpa arah saat guard 15 menit aktif', () => {
  const { ctx } = sandbox();
  const now = Date.parse('2026-11-20T14:05:00Z');
  vm.runInContext(`
    assetPrice = () => 3000;
    macroImpactCatalyst = () => ({ e: { Date: new Date(${now - 5 * 60000}).toISOString(), Event: 'CPI', Country: 'USD', Importance: 3 } });
    detectPriceSpike = () => ({ state: 'SPIKE_UP', label: 'Spike ATR', move5mPct: 2 });
    assetBars = () => [];
    const sh = forecastShock('XAU/USD', 'gold', ${now}, 3000);
  `, ctx);
  const sh = vm.runInContext('sh', ctx);
  assert.ok(sh.block, 'phase live harus mem-blok');
  assert.equal(sh.dir, null, 'spike tidak boleh menghasilkan arah saat block');
  assert.equal(sh.source, '');
});

test('forecastState: block mengunci final WAIT; news/spike hanya veto, tidak mengubah TF', () => {
  const { ctx } = sandbox();
  const end = Date.parse('2026-11-20T00:00:00Z');
  const rows = [];
  // 1100 harian ≈ 36 bar monthly crypto / 50 bar monthly forex — cukup untuk EMA10+RSI14.
  for (let i = 1099; i >= 0; i--) {
    const t = new Date(end - i * 86400000).toISOString().slice(0, 10);
    rows.push(bar(t, 2000 * Math.pow(1.002, 1099 - i)));
  }
  vm.runInContext(`
    HTF = { asOf: '2026-11-20', pairs: { 'XAU/USD': { symbol: 'GC=F', bars: ${JSON.stringify(rows)} } } };
    riskSentimentSnapshot = () => ({ regime: 'MIXED', label: 'MIXED' });
    effectiveFearGreed = () => ({ label: 'Neutral' });
    calibratedWatchSignal = () => ({ candidateDir: null, netScore: -2, factors: [] });
    assetPrice = () => 3000;
    execEntries = () => null;
  `, ctx);

  const nowA = Date.parse('2026-11-25T00:00:00Z');
  vm.runInContext(`forecastShock = () => ({ dir: null, source: '', note: '', block: 'High-impact < 15 menit — arah ditahan.' }); const blocked = forecastState(${nowA});`, ctx);
  const blocked = vm.runInContext('blocked', ctx).items.find(x => x.asset === 'XAU/USD');
  assert.equal(blocked.final.dir, null, 'guard 15 menit harus mengunci final');
  assert.match(blocked.final.reason, /Final WAIT/);
  assert.equal(blocked.finalLevels, null);

  // Tanpa block: TA tetap BUY walau news berkata SELL; news hanya mem-veto final.
  const nowB = Date.parse('2026-11-25T00:01:00Z');
  vm.runInContext(`forecastShock = () => ({ dir: 'sell', source: 'news', note: '', block: null }); const vetoed = forecastState(${nowB});`, ctx);
  const vetoed = vm.runInContext('vetoed', ctx).items.find(x => x.asset === 'XAU/USD');
  assert.equal(vetoed.tfs.daily.dir, 'buy', 'arah TF tidak boleh diubah news');
  assert.equal(vetoed.tfs.weekly.dir, 'buy');
  assert.equal(vetoed.tfs.monthly.dir, 'buy');
  assert.equal(vetoed.final.dir, null, 'katalis yang melawan arah HTF mem-veto final');

  // Tanpa katalis: D/W/M buy → final BUY, final level memakai ATR daily.
  const nowC = Date.parse('2026-11-25T00:02:00Z');
  vm.runInContext(`forecastShock = () => ({ dir: null, source: '', note: '', block: null }); const clean = forecastState(${nowC});`, ctx);
  const clean = vm.runInContext('clean', ctx).items.find(x => x.asset === 'XAU/USD');
  assert.equal(clean.final.dir, 'buy');
  assert.ok(clean.finalLevels, 'final level ada saat aligned');
  assert.equal(clean.tfs.monthly.levels.illustrative, true, 'kartu monthly ditandai ilustrasi');
  assert.notEqual(clean.tfs.monthly.levels.targetPct, clean.finalLevels.targetPct, 'final level tidak memakai ATR monthly');
});

test('forecastTargets: ATR monthly dibatasi 5%/10% dari harga', () => {
  const { ctx } = sandbox();
  vm.runInContext(`execEntries = () => null; const lv = forecastTargets('XAU/USD', 'gold', 'monthly', { atrAbs: 525, atrPct: 15 }, 3000, 'buy', { movePct: 0 });`, ctx);
  const lv = vm.runInContext('lv', ctx);
  assert.ok(lv.riskPct <= 5.0001, 'SL monthly tidak boleh ratusan dollar tidak realistis');
  assert.ok(lv.targetPct <= 10.0001);
  assert.equal(lv.illustrative, true);
});

test('HTF TA memakai close bar yang sejenis, bukan bid/ask spot (basis GC=F)', () => {
  const { ctx } = sandbox();
  const end = Date.parse('2026-11-20T00:00:00Z');
  const rows = [];
  for (let i = 119; i >= 0; i--) {
    const t = new Date(end - i * 86400000).toISOString().slice(0, 10);
    rows.push(bar(t, 100 + (119 - i)));
  }
  const res = vm.runInContext(`htfDirection(${JSON.stringify(rows)}, 'daily', 9999, { kind: 'gold', now: ${Date.parse('2026-11-25T00:00:00Z')} })`, ctx);
  assert.equal(res.priceBasis, 'bar-close');
  assert.ok(res.emaFast > 0 && res.lastClose < 1000, 'EMA dihitung dari close futures, bukan spot 9999');
});
