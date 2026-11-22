// Penghasil data Higher-Timeframe (D/W/M) untuk panel forecast.
//
// Data 1m/5m yang dipakai board teknikal hanya mencakup beberapa hari, jadi
// tidak cukup untuk bacaan weekly/monthly. Script ini mengambil bar HARIAN
// Yahoo Finance (interval=1d, range=2y) untuk seluruh aset yang dipantau,
// lalu menyimpannya ke data/htf.json. Browser yang melakukan agregasi ke
// weekly/monthly supaya satu sumber data dipakai ketiga timeframe.
//
// generatedAt sengaja memakai tanggal bar terakhir (bukan waktu fetch) agar
// workflow 15 menit tidak membuat commit baru bila data harian belum berubah.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'data', 'htf.json');
const RANGE = '2y';
const HEADERS = { 'user-agent': 'Mozilla/5.0' };
const FRESH_MS = 20 * 60 * 60 * 1000;

export const HTF_SYMBOLS = [
    { pair: 'EUR/USD', symbol: 'EURUSD=X' },
    { pair: 'GBP/USD', symbol: 'GBPUSD=X' },
    { pair: 'USD/JPY', symbol: 'USDJPY=X' },
    { pair: 'USD/CHF', symbol: 'USDCHF=X' },
    { pair: 'AUD/USD', symbol: 'AUDUSD=X' },
    { pair: 'USD/CAD', symbol: 'USDCAD=X' },
    { pair: 'NZD/USD', symbol: 'NZDUSD=X' },
    { pair: 'GBP/JPY', symbol: 'GBPJPY=X' },
    { pair: 'EUR/JPY', symbol: 'EURJPY=X' },
    { pair: 'XAU/USD', symbol: 'GC=F' },
    { pair: 'BTC/USD', symbol: 'BTC-USD' },
    { pair: 'ETH/USD', symbol: 'ETH-USD' },
    { pair: 'US500', symbol: '^GSPC' }
];

const finite = v => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

export async function fetchHtfDaily(symbol, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${RANGE}`;
    const r = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const chart = j && j.chart && j.chart.result && j.chart.result[0];
    if (!chart) throw new Error('chart kosong');
    const ts = Array.isArray(chart.timestamp) ? chart.timestamp : [];
    const q = chart.indicators && chart.indicators.quote && chart.indicators.quote[0];
    const byDate = new Map();
    for (let i = 0; i < ts.length; i++) {
        const t = new Date(Number(ts[i]) * 1000).toISOString().slice(0, 10);
        const o = finite(q && q.open && q.open[i]);
        const h = finite(q && q.high && q.high[i]);
        const l = finite(q && q.low && q.low[i]);
        const c = finite(q && q.close && q.close[i]);
        if (!(o > 0 && h > 0 && l > 0 && c > 0)) continue;
        // 6 desimal sudah jauh di bawah spread aset apa pun — menghemat payload.
        const r6 = v => Number(v.toFixed(6));
        byDate.set(t, { t, o: r6(o), h: r6(h), l: r6(l), c: r6(c) });
    }
    const rows = [...byDate.values()].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
    if (!rows.length) throw new Error('seri harian kosong');
    return rows.slice(-420);
}

function asOfOf(pairs) {
    const dates = Object.values(pairs).flatMap(x => (Array.isArray(x.bars) ? x.bars.map(b => b.t) : []));
    return dates.sort().slice(-1)[0] || new Date().toISOString().slice(0, 10);
}

export async function fetchHtf({ write = true, force = false, fetchImpl = fetch } = {}) {
    if (!force) {
        try {
            const st = await fs.stat(OUT);
            const old = JSON.parse(await fs.readFile(OUT, 'utf8'));
            if (Date.now() - st.mtimeMs < FRESH_MS && old && Object.keys(old.pairs || {}).length >= 10) {
                console.log('HTF masih segar — fetch dilewati.');
                return old;
            }
        } catch {}
    }

    const pairs = {};
    const errors = [];
    await Promise.all(HTF_SYMBOLS.map(async cfg => {
        try {
            const bars = await fetchHtfDaily(cfg.symbol, { fetchImpl });
            if (bars.length < 30) throw new Error(`hanya ${bars.length} bar`);
            pairs[cfg.pair] = { symbol: cfg.symbol, bars };
        } catch (e) {
            errors.push(`${cfg.pair} (${cfg.symbol}): ${e.message || e}`);
        }
    }));

    if (!Object.keys(pairs).length) {
        throw new Error(`Gagal mengambil semua data HTF: ${errors.join(' | ')}`);
    }

    const asOf = asOfOf(pairs);
    const payload = {
        generatedAt: `${asOf}T00:00:00.000Z`,
        asOf,
        source: `Yahoo Finance 1d OHLC (interval=1d&range=${RANGE})`,
        symbols: Object.fromEntries(HTF_SYMBOLS.map(c => [c.pair, c.symbol])),
        pairs,
        errors
    };
    const next = JSON.stringify(payload, null, 2) + '\n';
    if (write) {
        const prev = await fs.readFile(OUT, 'utf8').catch(() => null);
        if (prev !== next) {
            await fs.writeFile(OUT, next);
            console.log('HTF tersimpan:', asOf, `${Object.keys(pairs).length}/${HTF_SYMBOLS.length} aset`);
        } else {
            console.log('HTF tidak berubah:', asOf);
        }
    }
    if (errors.length) console.warn('HTF sebagian gagal:', errors.join(' | '));
    return payload;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    fetchHtf().catch(e => {
        console.error('fetch-htf gagal:', e.message || e);
        process.exitCode = 1;
    });
}
