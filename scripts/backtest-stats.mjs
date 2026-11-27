#!/usr/bin/env node
/**
 * backtest-stats.mjs — Backtest winrate JANGKA PANJAX (60 hari) untuk panel statistik.
 *
 * Masalah yang dipecahkan: panel di halaman hanya punya data/history-bars.json
 * 5 hari. Dengan gerbang kualitas yang ketat, 5 hari hanya menghasilkan ~3-4 trade
 * closed -> winrate yang tampil (mis. 30%) adalah NOISE murni (CI95 6-79%).
 * Evaluasi 60 hari di dalam browser butuh ~10 menit, jadi dihitung DI SINI
 * (Node, sekali sehari via CI) lalu disimpan sebagai data/backtest-stats.json
 * yang ringan dan tinggal ditampilkan halaman.
 *
 * Output: data/backtest-stats.json
 *   {
 *     generatedAt, sourceLabel, rangeStart, rangeEnd, windowDays,
 *     overall,        // ringkasan setup pasca-rilis (engine) — headline winrate
 *     watchSummary,   // diagnostik jalur Watch (tanpa rilis) — dilaporkan terpisah
 *     byKind, recentTrades, method
 *   }
 *
 * Pemakaian:  node scripts/backtest-stats.mjs
 *             NI_BT_RANGE=60d NI_BT_OUT=data/backtest-stats.json
 */
import vm from 'node:vm';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RANGE = process.env.NI_BT_RANGE || '60d';
const OUT = process.env.NI_BT_OUT || join(ROOT, 'data/backtest-stats.json');
const WINDOW_DAYS = Number(RANGE.replace(/[^0-9]/g, '')) || 60;

/* ── 1. Bar 5m dari Yahoo (semua pair yang dipakai halaman) ─────────────── */
const SYMBOLS = {
  'EUR/USD': 'EURUSD=X', 'GBP/USD': 'GBPUSD=X', 'USD/JPY': 'USDJPY=X',
  'USD/CHF': 'USDCHF=X', 'AUD/USD': 'AUDUSD=X', 'USD/CAD': 'USDCAD=X',
  'NZD/USD': 'NZDUSD=X', 'GBP/JPY': 'GBPJPY=X', 'EUR/JPY': 'EURJPY=X',
  'XAU/USD': 'GC=F', 'BTC/USD': 'BTC-USD', 'ETH/USD': 'ETH-USD', 'US500': 'ES=F'
};

async function fetchBars(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=5m&range=${RANGE}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`${sym} HTTP ${r.status}`);
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error(`${sym} no data`);
  const ts = res.timestamp || [], q = res.indicators.quote[0];
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if (!(o > 0 && h > 0 && l > 0 && c > 0)) continue;
    bars.push({ k: Math.floor(ts[i] / 60), o: +o.toFixed(6), h: +h.toFixed(6), l: +l.toFixed(6), c: +c.toFixed(6) });
  }
  return bars;
}

async function loadBars() {
  const pairs = {};
  await Promise.all(Object.entries(SYMBOLS).map(async ([pair, sym]) => {
    try {
      const bars = await fetchBars(sym);
      if (bars.length >= 45) pairs[pair] = bars;
      console.log(`  ${pair.padEnd(8)} ${bars.length} bar`);
    } catch (e) { console.warn(`  ${pair.padEnd(8)} GAGAL: ${e.message}`); }
  }));
  if (!Object.keys(pairs).length) throw new Error('Tidak ada bar yang berhasil diambil');
  return { generatedAt: new Date().toISOString(), intervalMin: 5, source: `yahoo ${RANGE} (backtest offline)`, pairs };
}

/* ── 2. Sandbox halaman (sama seperti tests/signal-history.test.mjs) ───── */
function sandbox() {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('inline <script> tidak ditemukan di index.html');
  const noop = () => {};
  const store = new Map();
  const box = {
    console, Math, Date, Number, String, Boolean, Array, Object, JSON, RegExp, Error, Promise, Intl,
    encodeURIComponent, decodeURIComponent, isFinite: Number.isFinite, isNaN: Number.isNaN,
    setTimeout: noop, clearTimeout: noop, setInterval: () => 1, clearInterval: noop,
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' }),
    localStorage: {
      get length() { return store.size; },
      key: i => Array.from(store.keys())[i] ?? null,
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
      clear: () => store.clear()
    },
    document: {
      querySelector: () => ({ innerHTML: '', textContent: '', style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener() {}, closest: () => null }),
      querySelectorAll: () => [],
      getElementById: () => ({ innerHTML: '', textContent: '', style: {}, dataset: {} }),
      createElement: () => ({ innerHTML: '', textContent: '', style: {}, classList: { add() {}, remove() {} }, setAttribute() {} })
    }
  };
  box.window = box; box.globalThis = box;
  const ctx = vm.createContext(box);
  vm.runInContext(match[1], ctx, { filename: 'index.html' });
  vm.runInContext(readFileSync(join(ROOT, 'signal-engine.js'), 'utf8'), ctx, { filename: 'signal-engine.js' });
  return ctx;
}

/* ── 3. Hitung & simpan ──────────────────────────────────────────────────── */
const t0 = Date.now();
console.log(`Backtest offline ${RANGE} …`);
const hist = await loadBars();
const calendar = JSON.parse(readFileSync(join(ROOT, 'data/calendar.json'), 'utf8'));

const ctx = sandbox();
ctx.__HIST = hist;
ctx.__CAL = calendar;
vm.runInContext('HISTORY_BARS = __HIST; MARKETS = null; events = __CAL;', ctx);

const tEval = Date.now();
const res = vm.runInContext('evaluateSignalHistory({ liveHistory: [], now: Date.now() })', ctx);
console.log(`eval ${(Date.now() - tEval) / 1000 | 0}s`);

const times = Object.values(hist.pairs).flatMap(b => [b[0].k * 60000, b[b.length - 1].k * 60000]);
const payload = {
  generatedAt: new Date().toISOString(),
  windowDays: WINDOW_DAYS,
  range: RANGE,
  sourceLabel: res.sourceLabel,
  rangeStart: res.rangeStart,
  rangeEnd: res.rangeEnd,
  method: 'Isi order LIMIT diuji dengan semantik BENAR (harga harus menyentuh level, TTL orderTtlMin), '
    + 'tanpa pairGate (dinilai negatif pada walk-forward 60 hari), gerbang sesi UTC 07-21 + cooldown 45 menit aktif. '
    + 'Headline = setup pasca-rilis (SignalEngine); jalur Watch dilaporkan terpisah.',
  overall: res.overall,
  watchSummary: res.watchSummary,
  byKind: res.byKind,
  recentTrades: (res.recentTrades || []).slice(0, 14)
};

writeFileSync(OUT, JSON.stringify(payload, null, 1));
const o = payload.overall;
console.log(`\nHeadline (pasca-rilis): closed=${o.closedCount} WR=${o.winRatePct}% CI95 ${o.winRateCiLow}-${o.winRateCiHigh}% net=${o.netR}R PF=${o.profitFactor}`);
const w = payload.watchSummary;
if (w && w.total) console.log(`Watch (diagnostik):     closed=${w.closedCount} WR=${w.winRatePct}% net=${w.netR}R`);
console.log(`range ${(new Date(Math.min(...times))).toISOString().slice(0, 10)} → ${(new Date(Math.max(...times))).toISOString().slice(0, 10)} • tulis ${OUT} • total ${((Date.now() - t0) / 60000).toFixed(1)} menit`);
