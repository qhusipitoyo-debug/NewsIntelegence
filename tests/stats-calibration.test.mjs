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
  assert.ok(match);
  const box = {
    console: { log() {}, warn() {}, error() {} },
    Date, Intl, Math, JSON, Number, String, Object, Array, Promise, RegExp, encodeURIComponent,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    localStorage: { getItem: () => null, setItem: () => {} },
    fetch: () => new Promise(() => {}),
    document: {
      querySelector: () => ({ innerHTML: '', textContent: '', style: {}, classList: { add() {}, remove() {} }, addEventListener() {} }),
      querySelectorAll: () => [],
      getElementById: () => ({ innerHTML: '', textContent: '', style: {} })
    }
  };
  box.window = box;
  const ctx = vm.createContext(box);
  vm.runInContext(match[1], ctx);
  return ctx;
}

test('satu definisi win: r > 0 menang, r = 0 FLAT (label outcome tidak dipakai)', () => {
  const ctx = sandbox();
  const out = vm.runInContext(`summarizeTradeSet([
    { closed: true, outcome: 'WIN_TP1', r: 0 },
    { closed: true, outcome: 'WIN_TP2', r: 0 },
    { closed: true, outcome: 'NOFILL', r: 0 },
    { closed: true, outcome: 'LOSS', r: -1 },
    { closed: true, outcome: 'WIN_TP1', r: 0.5 }
  ])`, ctx);
  assert.equal(out.winsCount, 1, 'hanya trade dengan r > 0 yang win');
  assert.equal(out.lossesCount, 1);
  assert.equal(out.flatCount, 3);
  assert.equal(out.winRatePct, 20);
  const bucket = vm.runInContext(`confidenceBuckets([
    { closed: true, conf: 85, outcome: 'WIN_TP1', r: 0 },
    { closed: true, conf: 85, outcome: 'LOSS', r: 0.48 }
  ])[3]`, ctx);
  assert.equal(bucket.wins, 1, 'bucket juga harus memakai definisi r > 0');
});

test('Wilson CI 95% untuk 62/124 ≈ 41–59% (bukan angka tunggal)', () => {
  const ctx = sandbox();
  const ci = vm.runInContext('wilsonInterval(62, 124)', ctx);
  assert.ok(ci.low > 41 && ci.low < 44, JSON.stringify(ci));
  assert.ok(ci.high > 56 && ci.high < 60, JSON.stringify(ci));
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('wilsonInterval(0, 0)', ctx))), { low: null, high: null });
});

test('sweepWinrateParams ditolak di bawah 100 sampel closed (anti-overfit)', () => {
  const ctx = sandbox();
  const res = vm.runInContext(`
    evaluateSignalHistory = () => ({ overall: { closedCount: 4, winRatePct: 100, winRateCiLow: 51, winRateCiHigh: 99 } });
    sweepWinrateParams();
  `, ctx);
  assert.equal(res.rejected, true);
  assert.equal(res.samples, 4);
  assert.match(res.reason, /Kalibrasi ditolak/);
  // Parameter tidakBerubah saat ditolak
  assert.equal(vm.runInContext('WINRATE_PARAMS.baseRR', ctx), 2);
});

test('model biaya tunggal: spread sudah di entry, tidak dikurangi lagi (-1R)', () => {
  const ctx = sandbox();
  const bar = { o: 100, h: 100.4, l: 98.8, c: 100 };
  const plain = vm.runInContext(`simulateTradeOnBars('long', 100, 99, 101, 102, [${JSON.stringify(bar)}], 'gold')`, ctx);
  assert.equal(plain.r, -1, 'SL 1R tetap -1R, bukan -1.02R');
  const explicit = vm.runInContext(`simulateTradeOnBars('long', 100, 99, 101, 102, [${JSON.stringify(bar)}], 'gold', Infinity, 0.02)`, ctx);
  assert.equal(explicit.r, -1.02, 'biaya ekstra hanya bila disebut eksplisit');
});

test('panel kalibrasi memberi peringatan sampel kecil & menandai bucket <20', () => {
  const ctx = sandbox();
  const html = vm.runInContext(`
    renderValidationPanel({
      overall: { winRatePct: 50, winsCount: 2 },
      recentTrades: [
        { closed: true, conf: 75, r: 1 },
        { closed: true, conf: 75, r: -1 },
        { closed: true, conf: 85, r: 0.5 }
      ]
    });
  `, ctx);
  assert.match(html, /Sampel <b>3<\/b> closed/);
  assert.match(html, /CI95/);
  assert.match(html, /n\/a — sampel &lt;20/);
});
