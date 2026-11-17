/*!
 * signal-engine.js  v1.1  —  NewsIntelegence / shidiqpiy XAUUSD News Terminal
 *
 * Pengganti logika sinyal pasca-news. Satu file, bisa dipakai di browser
 * (window.SignalEngine) maupun Node (require). Tanpa dependensi.
 *
 * Perubahan utama vs versi lama (winrate 50%, PF 0.90, avg win 0.92R / loss 1.02R):
 *  1. Tidak ada entry MARKET pra-rilis (Forecast vs Previous tidak punya edge).
 *  2. Gerbang kualitas: impact 3, reaksi >= 1x ATR(5m), surprise bermakna,
 *     Actual & harga HARUS searah (konflik = fakeout -> NO TRADE).
 *  3. Entry LIMIT di retrace impuls (default 50%), bukan mengejar di ujung impuls.
 *  4. SL struktural (di balik asal impuls + 0.25 ATR5m), R dihitung dari harga
 *     eksekusi termasuk spread (BUY di ask, SELL di bid).
 *  5. TP1 1R (tutup 50% + BE), TP2 2R, trailing opsional, expiry mark-to-market.
 *  6. Maks N aset per event (sinyal berkorelasi dihitung sebagai satu klaster).
 *  7. Simulator + statistik (per exit reason, per kategori, per event) agar
 *     kalibrasi memakai data, bukan tebakan.
 *
 * Format bar: { t: epochMs, o, h, l, c }  (urut naik, 1 menit)
 * Format event: { id, title, currency:'USD', impact:1..3, ts: epochMs,
 *                 actual:'3.1%', forecast:'3.0%', previous:'2.9%' }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SignalEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN = 60000;

  /* ------------------------------------------------------------------ */
  /* KONFIGURASI                                                         */
  /* ------------------------------------------------------------------ */
  const CONFIG = {
    minImpact: 2,               // High + Medium impact (impact 1 = skenario halaman)
    waitMin: 15,                // tidak ada entry 15 menit pertama
    reactMaxMin: 45,            // jendela pengukuran reaksi
    planUntilMin: 90,           // setelah ini tidak membuat order baru
    minReactAtr: 1.0,           // reaksi >= 1.0 x ATR(5m) (dalam %)
    atrPeriod: 14,
    retrace: 0.5,               // 0.382–0.618 (zona OTE)
    slBufferAtr: 0.25,          // buffer SL di balik asal impuls
    minRiskAtr: 1.0,            // risiko minimal (x ATR5m) agar tidak kena noise
    maxRiskAtr: 20,             // risiko maksimal; di atas ini RR tidak layak
    tp1R: 1.0, tp1Share: 0.5,   // TP1 1R tutup 50% lalu SL ke BE
    tp2R: 2.0,
    trailBars: 15,              // trailing (menit) setelah TP1; 0 = mati
    orderTtlMin: 30,            // order limit dibatalkan bila tak terisi
    holdMin: 240,               // posisi ditutup paksa (mark-to-market)
    cancelOnNewExtreme: true,   // harga lari melewati ujung impuls tanpa pullback
    maxAssetsPerEvent: 3,       // klaster korelasi
    defaultSpreadPct: 0.01,     // % bila spread broker tidak tersedia
    maxSpreadAtr: 0.6,          // spread > 0.6 x ATR(5m) = kondisi untradeable
    maxRetraceFrac: 0.85,       // harga sudah retrace > 85% impuls = setup batal
  };

  /* Kategori event: tipe + selisih minimum |actual-forecast| (satuan data) */
  const CATEGORIES = [
    { key: 'cpi',      re: /\b(cpi|inflation|ppi|pce|price index)\b/i,        type: 'inflation', minDiff: 0.1 },
    { key: 'nfp',      re: /non-?farm|nfp|employment change|payrolls?/i,      type: 'labor',     minDiff: 25 },
    { key: 'unemp',    re: /unemployment rate/i,                               type: 'inverse',   minDiff: 0.1 },
    { key: 'claims',   re: /jobless|claims/i,                                  type: 'inverse',   minDiff: 10 },
    { key: 'rate',     re: /interest rate|rate decision|fomc|funds rate|bank rate|cash rate/i, type: 'rate', minDiff: 0.01 },
    { key: 'gdp',      re: /\bgdp\b/i,                                         type: 'growth',    minDiff: 0.1 },
    { key: 'retail',   re: /retail sales/i,                                    type: 'growth',    minDiff: 0.2 },
    { key: 'ism',      re: /\bism\b/i,                                         type: 'growth',    minDiff: 0.8 },
  ];
  /* PMI S&P Global & sejenis sengaja TIDAK ada di whitelist (tidak punya Actual publik). */

  /* Hubungan aset ↔ kekuatan mata uang: +1 naik saat mata uang menguat. */
  const ASSETS = {
    'XAU/USD': { cls: 'cmd',    legs: { USD: -1 } },
    'BTC/USD': { cls: 'crypto', legs: { USD: -1 } },
    'ETH/USD': { cls: 'crypto', legs: { USD: -1 } },
    'EUR/USD': { cls: 'fx', pip: 0.0001, legs: { EUR: 1, USD: -1 } },
    'GBP/USD': { cls: 'fx', pip: 0.0001, legs: { GBP: 1, USD: -1 } },
    'AUD/USD': { cls: 'fx', pip: 0.0001, legs: { AUD: 1, USD: -1 } },
    'NZD/USD': { cls: 'fx', pip: 0.0001, legs: { NZD: 1, USD: -1 } },
    'USD/JPY': { cls: 'fx', pip: 0.01,   legs: { USD: 1, JPY: -1 } },
    'USD/CHF': { cls: 'fx', pip: 0.0001, legs: { USD: 1, CHF: -1 } },
    'USD/CAD': { cls: 'fx', pip: 0.0001, legs: { USD: 1, CAD: -1 } },
    'GBP/JPY': { cls: 'fx', pip: 0.01,   legs: { GBP: 1, JPY: -1 } },
    'EUR/JPY': { cls: 'fx', pip: 0.01,   legs: { EUR: 1, JPY: -1 } },
    'NAS100':  { cls: 'index', ccy: 'USD' },
    'US500':   { cls: 'index', ccy: 'USD' },
  };

  /* ------------------------------------------------------------------ */
  /* UTIL                                                                */
  /* ------------------------------------------------------------------ */
  function parseNum(v) {
    if (v == null) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    const s = String(v).trim().replace(/,/g, '');
    const m = s.match(/^(-?\d+(?:\.\d+)?)\s*([kmbt%]?)/i);
    if (!m) return null;
    let n = parseFloat(m[1]);
    const u = m[2].toLowerCase();
    // satuan K/M/B dibiarkan apa adanya: actual & forecast memakai satuan yang sama
    return isFinite(n) ? n : null;
  }

  function categoryOf(title) {
    for (const c of CATEGORIES) if (c.re.test(title || '')) return c;
    return null;
  }

  function aggregate(bars, minutes) {
    const out = [];
    let cur = null;
    const span = minutes * MIN;
    for (const b of bars) {
      const k = Math.floor(b.t / span) * span;
      if (!cur || cur.t !== k) { cur = { t: k, o: b.o, h: b.h, l: b.l, c: b.c }; out.push(cur); }
      else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; }
    }
    return out;
  }

  function atr(bars, n) {
    if (bars.length < 2) return null;
    const trs = [];
    for (let i = 1; i < bars.length; i++) {
      const p = bars[i - 1].c, b = bars[i];
      trs.push(Math.max(b.h - b.l, Math.abs(b.h - p), Math.abs(b.l - p)));
    }
    const tail = trs.slice(-n);
    return tail.reduce((a, x) => a + x, 0) / tail.length;
  }

  /* ATR 5 menit dari bar SEBELUM rilis (bukan dari volatilitas lonjakan itu sendiri). */
  function atr5mBefore(bars1m, ts, n) {
    const pre = bars1m.filter(b => b.t < ts - 5 * MIN);
    const a5 = aggregate(pre, 5);
    const a = atr(a5.slice(-(n + 2)), n);
    return a;
  }

  function spreadFor(asset, price, quotes) {
    const q = quotes && quotes[asset];
    if (q && isFinite(q.spread) && q.spread > 0) return q.spread;           // satuan harga
    return price * (CONFIG.defaultSpreadPct / 100);
  }

  /* ------------------------------------------------------------------ */
  /* ARAH FUNDAMENTAL (asset-relative)                                   */
  /* ------------------------------------------------------------------ */
  function surprise(ev) {
    const a = parseNum(ev.actual), f = parseNum(ev.forecast);
    if (a == null || f == null) return null;
    return a - f;
  }

  /* +1/-1/0: arah aset yang didukung oleh Actual vs Forecast. */
  function fundamentalDir(ev, asset) {
    const cat = categoryOf(ev.title);
    const meta = ASSETS[asset];
    const diff = surprise(ev);
    if (!cat || !meta || diff == null || Math.abs(diff) < cat.minDiff) return 0;
    const raw = Math.sign(diff);
    // kekuatan mata uang event: inverse (unemployment, claims) -> balik tanda
    const strength = cat.type === 'inverse' ? -raw : raw;

    if (meta.cls === 'index') {
      if (ev.currency !== meta.ccy) return 0;
      if (cat.type === 'inflation' || cat.type === 'rate') return -raw;     // lebih tinggi = tekanan suku bunga
      return strength;                                                      // growth/labor: kuat = risk-on
    }
    const leg = meta.legs[ev.currency];
    if (!leg) return 0;
    return leg * strength;
  }

  /* ------------------------------------------------------------------ */
  /* REAKSI HARGA                                                        */
  /* ------------------------------------------------------------------ */
  function reaction(bars, releaseTs, now) {
    const base = [...bars].reverse().find(b => b.t <= releaseTs);
    if (!base) return null;
    const end = Math.min(now, releaseTs + CONFIG.reactMaxMin * MIN);
    const after = bars.filter(b => b.t > releaseTs && b.t <= now);
    if (!after.length) return null;
    const last = [...bars].reverse().find(b => b.t <= end);
    if (!last || last.t < releaseTs + CONFIG.waitMin * MIN - MIN) return null;

    const win = bars.filter(b => b.t >= releaseTs - MIN && b.t <= now);
    const impulseHigh = Math.max(...win.map(b => b.h));
    const impulseLow  = Math.min(...win.map(b => b.l));
    const movePct = (last.c - base.c) / base.c * 100;
    const cur = [...bars].reverse().find(b => b.t <= now);
    return {
      baseClose: base.c, lastClose: last.c, movePct,
      dir: movePct > 0 ? 1 : movePct < 0 ? -1 : 0,
      impulseHigh, impulseLow, price: cur.c,
      minutes: Math.round((last.t - releaseTs) / MIN),
    };
  }

  /* ------------------------------------------------------------------ */
  /* GERBANG KUALITAS                                                    */
  /* ------------------------------------------------------------------ */
  function tradeGate(ev, asset, ctx) {
    const cfg = CONFIG;
    const cat = categoryOf(ev.title);
    if (!cat)                               return no('kategori tidak di-whitelist');
    if ((ev.impact || 0) < cfg.minImpact)   return no('impact < ' + cfg.minImpact);
    if (ctx.minsSince < cfg.waitMin)        return no('tunggu konfirmasi ' + cfg.waitMin + ' menit');
    if (ctx.minsSince > cfg.planUntilMin)   return no('jendela sinyal habis');
    if (!ctx.react || !ctx.react.dir)       return no('belum ada reaksi harga');
    if (!ctx.atr5)                          return no('ATR 5m tidak tersedia');
    const atrPct = ctx.atr5 / ctx.react.baseClose * 100;
    if (Math.abs(ctx.react.movePct) < cfg.minReactAtr * atrPct) return no('reaksi < ' + cfg.minReactAtr + ' ATR(5m)');
    if (!ctx.fundDir)                       return no('Actual tidak ada / surprise kecil');
    if (ctx.fundDir !== ctx.react.dir)      return no('Actual vs harga konflik (fakeout)');
    return { ok: true, dir: ctx.react.dir, score: Math.abs(ctx.react.movePct) / atrPct };
    function no(why) { return { ok: false, why }; }
  }

  /* ------------------------------------------------------------------ */
  /* PEMBUATAN ORDER                                                     */
  /* ------------------------------------------------------------------ */
  function buildOrder(ev, asset, dir, react, atr5, spread) {
    const cfg = CONFIG, d = dir;
    const range = react.impulseHigh - react.impulseLow;
    if (!(range > 0)) return null;
    const buf = cfg.slBufferAtr * atr5;
    // Spread melebar ekstrem pasca-rilis: RR riil hancur walau arah benar.
    if (atr5 > 0 && spread > cfg.maxSpreadAtr * atr5) return { skip: 'spread terlalu lebar (> ' + cfg.maxSpreadAtr + ' x ATR5m)' };

    let level, entry, sl;
    if (d > 0) {                                       // BUY: entry di ask
      level = react.impulseHigh - cfg.retrace * range;
      entry = level + spread;
      sl = react.impulseLow - buf;
    } else {                                           // SELL: entry di bid
      level = react.impulseLow + cfg.retrace * range;
      entry = level;
      sl = react.impulseHigh + buf;
    }
    const risk = d * (entry - sl);
    if (risk < cfg.minRiskAtr * atr5) return { skip: 'risiko < ' + cfg.minRiskAtr + ' ATR (SL terlalu rapat)' };
    if (risk > cfg.maxRiskAtr * atr5) return { skip: 'risiko > ' + cfg.maxRiskAtr + ' ATR (RR tidak layak)' };
    // harga sudah menembus asal impuls -> setup batal
    if (d > 0 ? react.price <= sl : react.price >= sl) return { skip: 'impuls sudah gagal' };
    // harga sudah retrace hampir seluruh impuls: pullback tinggal satu langkah
    // menjebol origin -> balik arah, jangan pasang limit di jalur kebalikannya.
    if (d > 0 ? react.price < react.impulseLow + (1 - cfg.maxRetraceFrac) * range
              : react.price > react.impulseHigh - (1 - cfg.maxRetraceFrac) * range) {
      return { skip: 'retrace > ' + Math.round(cfg.maxRetraceFrac * 100) + '% impuls (mungkin balik arah)' };
    }

    return {
      eventId: ev.id, title: ev.title, asset, dir: d, side: d > 0 ? 'BUY' : 'SELL',
      type: 'LIMIT', entry, sl, risk, spread,
      tp1: entry + d * cfg.tp1R * risk,
      tp2: entry + d * cfg.tp2R * risk,
      impulseHigh: react.impulseHigh, impulseLow: react.impulseLow,
      expiresAt: null, holdUntil: ev.ts + cfg.holdMin * MIN,
    };
  }

  /* Satu event -> daftar order (maks N aset berperingkat). */
  function planEvent(ev, barsBySymbol, now, quotes) {
    const minsSince = (now - ev.ts) / MIN;
    const cands = [], rejected = [];

    for (const asset of Object.keys(ASSETS)) {
      const bars = barsBySymbol[asset];
      if (!bars || bars.length < 60) continue;
      const fundDir = fundamentalDir(ev, asset);
      if (!fundDir && !ASSETS[asset].legs?.[ev.currency] && ASSETS[asset].ccy !== ev.currency) continue; // aset tidak terdampak
      const react = reaction(bars, ev.ts, now);
      const a5 = atr5mBefore(bars, ev.ts, CONFIG.atrPeriod);
      const g = tradeGate(ev, asset, { minsSince, react, atr5: a5, fundDir });
      if (!g.ok) { rejected.push({ asset, why: g.why }); continue; }
      const spread = spreadFor(asset, react.price, quotes);
      const o = buildOrder(ev, asset, g.dir, react, a5, spread);
      if (!o || o.skip) { rejected.push({ asset, why: o ? o.skip : 'range 0' }); continue; }
      o.expiresAt = now + CONFIG.orderTtlMin * MIN;
      o.score = g.score;
      cands.push(o);
    }
    cands.sort((a, b) => b.score - a.score);
    return { orders: cands.slice(0, CONFIG.maxAssetsPerEvent), rejected, dropped: cands.slice(CONFIG.maxAssetsPerEvent).map(o => o.asset) };
  }

  /* ------------------------------------------------------------------ */
  /* SIMULATOR (backtest bar-demi-bar, konservatif: SL dulu bila ambigu)  */
  /* ------------------------------------------------------------------ */
  function simulate(order, barsAfter) {
    const cfg = CONFIG, d = order.dir, sp = order.spread;
    const px = b => d > 0
      ? { fav: b.h, adv: b.l, open: b.o, close: b.c }
      : { fav: b.l + sp, adv: b.h + sp, open: b.o + sp, close: b.c + sp };

    let filled = false, entry = order.entry, sl = order.sl;
    let remaining = 1, realized = 0, tp1Hit = false;
    let exit = null, closedAt = null;
    const hist = [];

    for (const b of barsAfter) {
      if (b.t < (order.createdAt || 0)) continue;
      const p = px(b);

      if (!filled) {
        if (b.t > order.expiresAt) return res('NOFILL', 0, false);
        const touch = d > 0 ? (b.l + sp <= order.entry) : (b.h >= order.entry);
        // batal bila harga lari melewati ujung impuls tanpa pullback, atau gagal
        if (!touch && CONFIG.cancelOnNewExtreme &&
            (d > 0 ? b.h > order.impulseHigh : b.l < order.impulseLow)) return res('MISSED', 0, false);
        if (d * (p.adv - sl) <= 0 && !touch) return res('CANCEL', 0, false);
        if (!touch) continue;
        filled = true;
        entry = d > 0 ? Math.min(order.entry, b.o + sp) : Math.max(order.entry, b.o);
        hist.push(b);
        if (d * (p.adv - sl) <= 0) { realized = -1; exit = 'SL'; closedAt = b.t; return res('SL', -1, true); }
        continue;
      }

      hist.push(b);
      const risk = order.risk;

      // 1) SL (atau BE/trailing)
      if (d * (p.adv - sl) <= 0) {
        const px0 = d > 0 ? Math.min(sl, p.open) : Math.max(sl, p.open);
        const r = d * (px0 - entry) / risk;
        realized += remaining * r; closedAt = b.t;
        exit = tp1Hit ? (sl === order.sl ? 'SL' : (Math.abs(sl - entry) < 1e-9 ? 'BE' : 'TRAIL')) : 'SL';
        return res(exit, realized, true);
      }
      // 2) TP1
      if (!tp1Hit && d * (p.fav - order.tp1) >= 0) {
        realized += cfg.tp1Share * cfg.tp1R; remaining -= cfg.tp1Share; tp1Hit = true;
        sl = entry;                                                         // BE
      }
      // 3) TP2
      if (tp1Hit && d * (p.fav - order.tp2) >= 0 && d * (p.adv - sl) > 0) {
        realized += remaining * cfg.tp2R; closedAt = b.t;
        return res('TP2', realized, true);
      }
      // 4) trailing setelah TP1
      if (tp1Hit && cfg.trailBars > 0) {
        const w = hist.slice(-cfg.trailBars);
        const t = d > 0 ? Math.min(...w.map(x => x.l)) : Math.max(...w.map(x => x.h + sp));
        if (d * (t - sl) > 0 && d * (p.close - t) > 0) sl = t;
      }
      // 5) expiry (mark-to-market)
      if (b.t >= order.holdUntil) {
        const r = d * (p.close - entry) / risk;
        realized += remaining * r; closedAt = b.t;
        return res('EXPIRY', realized, true);
      }
    }
    return filled ? res('OPEN', realized + remaining * d * (px(barsAfter[barsAfter.length - 1]).close - entry) / order.risk, true)
                  : res('NOFILL', 0, false);

    function res(exitReason, r, wasFilled) {
      return { eventId: order.eventId, title: order.title, asset: order.asset, side: order.side,
               exit: exitReason, r: wasFilled ? +r.toFixed(3) : 0, filled: wasFilled, closedAt };
    }
  }

  /* ------------------------------------------------------------------ */
  /* STATISTIK                                                           */
  /* ------------------------------------------------------------------ */
  function summarize(trades) {
    const t = trades.filter(x => x.filled);
    const wins = t.filter(x => x.r > 0), loss = t.filter(x => x.r < 0);
    const gw = wins.reduce((a, x) => a + x.r, 0), gl = -loss.reduce((a, x) => a + x.r, 0);
    const n = t.length;
    const avgW = wins.length ? gw / wins.length : 0, avgL = loss.length ? gl / loss.length : 0;
    const wr = n ? wins.length / n : 0;
    return {
      closed: n,
      winrate: +(wr * 100).toFixed(1),
      profitFactor: gl ? +(gw / gl).toFixed(2) : null,
      netR: +(gw - gl).toFixed(2),
      expectancyR: n ? +((gw - gl) / n).toFixed(3) : 0,
      grossWinR: +gw.toFixed(1), grossLossR: +(-gl).toFixed(1),
      avgWinR: +avgW.toFixed(2), avgLossR: +(-avgL).toFixed(2),
      breakevenWinratePct: (avgW + avgL) ? +(avgL / (avgW + avgL) * 100).toFixed(1) : null,
      winrateStdErrPct: n ? +(Math.sqrt(wr * (1 - wr) / n) * 100).toFixed(1) : null,
    };
  }

  function groupBy(trades, keyFn) {
    const m = {};
    for (const t of trades) (m[keyFn(t)] = m[keyFn(t)] || []).push(t);
    const out = {};
    for (const k of Object.keys(m)) out[k] = summarize(m[k]);
    return out;
  }

  /* Satu event = satu sampel (rata-rata R seluruh aset event itu). */
  function eventClusterStats(trades) {
    const m = {};
    for (const t of trades.filter(x => x.filled)) (m[t.eventId] = m[t.eventId] || []).push(t.r);
    const rs = Object.values(m).map(a => a.reduce((x, y) => x + y, 0) / a.length);
    const n = rs.length, mean = n ? rs.reduce((a, b) => a + b, 0) / n : 0;
    const sd = n > 1 ? Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
    return { events: n, meanR: +mean.toFixed(3), sd: +sd.toFixed(3), tStat: sd ? +(mean / (sd / Math.sqrt(n))).toFixed(2) : null };
  }

  /* Backtest penuh. events: [...], barsBySymbol: {asset: bars1m}. */
  function backtest(events, barsBySymbol, opts) {
    opts = opts || {};
    const trades = [], log = [];
    for (const ev of events) {
      const now = ev.ts + (opts.planAtMin || 20) * MIN;
      const plan = planEvent(ev, barsBySymbol, now, opts.quotes);
      log.push({ event: ev.title, ts: ev.ts, orders: plan.orders.length, rejected: plan.rejected });
      for (const o of plan.orders) {
        o.createdAt = now;
        const after = barsBySymbol[o.asset].filter(b => b.t >= now);
        const r = simulate(o, after);
        r.category = (categoryOf(ev.title) || {}).key;
        trades.push(r);
      }
    }
    return {
      summary: summarize(trades),
      byExit: groupBy(trades, t => t.exit),
      byCategory: groupBy(trades.filter(t => t.filled), t => t.category),
      byAsset: groupBy(trades.filter(t => t.filled), t => t.asset),
      eventCluster: eventClusterStats(trades),
      trades, log,
    };
  }

  return {
    CONFIG, ASSETS, CATEGORIES,
    parseNum, categoryOf, aggregate, atr, atr5mBefore, spreadFor, surprise,
    fundamentalDir, reaction, tradeGate, buildOrder, planEvent,
    simulate, summarize, groupBy, eventClusterStats, backtest,
  };
});

/* ---------------- SELF-TEST:  node signal-engine.js --selftest ---------------- */
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module &&
    process.argv.includes('--selftest')) {
  const E = module.exports, MIN = 60000, T0 = Date.UTC(2026, 10, 18, 13, 30);
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  // harga sintetis: flat 2 jam, spike naik 20 menit, pullback, lalu lanjut naik
  function path(minute) {
    if (minute < 0) return 2000 + Math.sin(minute / 3) * 0.6;
    if (minute <= 20) return 2000 + minute * 1.0;                          // 2000 -> 2020
    if (minute <= 40) return 2020 - (minute - 20) * 0.6;                   // pullback ke ~2008
    return 2008 + (minute - 40) * 0.5;                                     // lanjut naik
  }
  const bars = [];
  for (let m = -150; m <= 260; m++) {
    const c = path(m), o = path(m - 1), n = (rnd() - 0.5) * 0.4;
    bars.push({ t: T0 + m * MIN, o, h: Math.max(o, c) + Math.abs(n), l: Math.min(o, c) - Math.abs(n), c });
  }
  const ev = { id: 'cpi1', title: 'Core CPI m/m', currency: 'USD', impact: 3, ts: T0,
               actual: '0.5%', forecast: '0.3%', previous: '0.3%' };
  // USD kuat (CPI > forecast) -> emas turun; tapi harga naik => konflik -> harus DITOLAK
  let plan = E.planEvent(ev, { 'XAU/USD': bars }, T0 + 20 * MIN);
  console.log('Konflik Actual vs harga ->', plan.orders.length === 0 ? 'OK (ditolak)' : 'GAGAL', plan.rejected);

  // Actual lebih rendah -> USD lemah -> emas naik, searah harga -> harus lolos
  const ev2 = Object.assign({}, ev, { id: 'cpi2', actual: '0.1%' });
  const bt = E.backtest([ev2], { 'XAU/USD': bars }, { planAtMin: 20 });
  console.log('Order:', bt.trades.length, '| exit:', bt.trades.map(t => t.exit + ' ' + t.r + 'R').join(', '));
  console.log(JSON.stringify(bt.summary));
  const ok = bt.trades.length === 1 && bt.trades[0].filled;
  console.log(ok ? 'SELFTEST OK' : 'SELFTEST GAGAL');
  process.exit(ok ? 0 : 1);
}
