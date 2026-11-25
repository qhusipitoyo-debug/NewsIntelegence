// Penghasil data Higher-Timeframe (D/W/M) untuk panel forecast.
//
// Data 1m/5m yang dipakai board teknikal hanya mencakup beberapa hari, jadi
// tidak cukup untuk bacaan weekly/monthly. Script ini mengambil bar HARIAN
// Yahoo Finance (interval=1d, range=5y) untuk seluruh aset yang dipantau,
// lalu menyimpannya ke data/htf.json. Browser yang melakukan agregasi ke
// weekly/monthly supaya satu sumber data dipakai ketiga timeframe.
//
// Range diperpanjang dari 2y ke 5y: 420 bar 1d hanya menghasilkan ~15 bar
// monthly untuk crypto, sehingga EMA10/RSI14 tidak stabil. 900 bar memberi
// ~30+ bar monthly. JSON ditulis ringkas (tanpa indentasi) agar payload tetap
// kecil meski histori diperpanjang.
//
// Bar tanggal hari ini ditandai `partial: true` dan dibuang browser saat
// menghitung arah — close harian/weekly/monthly yang belum selesai memicu
// repaint pada awal pekan/bulan.
//
// generatedAt sengaja memakai tanggal bar terakhir (bukan waktu fetch) agar
// workflow 15 menit tidak membuat commit baru bila data harian belum berubah.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'data', 'htf.json');
const RANGE = '5y';
const MAX_BARS = 1100;
const HEADERS = { 'user-agent': 'Mozilla/5.0' };
// mtime tidak dipakai: actions/checkout selalu membuat file "baru" sehingga
// cache 20 jam hampir selalu terlewat di CI. Kesegaran diukur dari asOf data.
const MAX_AS_OF_AGE_DAYS = 3;

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
    const today = new Date().toISOString().slice(0, 10);
    const trimmed = rows.slice(-MAX_BARS);
    // Bar hari berjalan belum close. Ditandai agar agregator browser bisa
    // membuangnya (bukan mengira itu close final weekly/monthly).
    if (trimmed.length && trimmed[trimmed.length - 1].t === today) {
        trimmed[trimmed.length - 1] = { ...trimmed[trimmed.length - 1], partial: true };
    }
    return trimmed;
}

// asOf harus tanggal bar TERAKHIR YANG SUDAH CLOSE, bukan bar hari berjalan.
function lastClosedDate(pair) {
    const rows = Array.isArray(pair && pair.bars) ? pair.bars : [];
    for (let i = rows.length - 1; i >= 0; i--) {
        if (!rows[i].partial) return rows[i].t;
    }
    return null;
}
function asOfOf(pairs) {
    const dates = Object.values(pairs).map(lastClosedDate).filter(Boolean).sort();
    return dates.slice(-1)[0] || new Date().toISOString().slice(0, 10);
}

export async function fetchHtf({ write = true, force = false, fetchImpl = fetch } = {}) {
    force = force || process.argv.includes('--force') || process.env.HTF_FORCE === 'true';
    if (!force) {
        try {
            const old = JSON.parse(await fs.readFile(OUT, 'utf8'));
            const cutoff = new Date(Date.now() - MAX_AS_OF_AGE_DAYS * 86400000).toISOString().slice(0, 10);
            if (old && old.asOf && old.asOf >= cutoff && Object.keys(old.pairs || {}).length >= 10) {
                console.log('HTF masih segar (asOf ' + old.asOf + ') — fetch dilewati.');
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
            const last = bars[bars.length - 1];
            pairs[cfg.pair] = {
                symbol: cfg.symbol,
                asOf: last && !last.partial ? last.t : (bars[bars.length - 2] || last).t,
                partial: last && last.partial === true,
                bars
            };
        } catch (e) {
            errors.push(`${cfg.pair} (${cfg.symbol}): ${e.message || e}`);
        }
    }));

    if (!Object.keys(pairs).length) {
        throw new Error(`Gagal mengambil semua data HTF: ${errors.join(' | ')}`);
    }

    const asOf = asOfOf(pairs);
    // asOf global dipakai untuk header; tiap aset menyimpan asOf-nya sendiri
    // (emas/indeks bisa berhenti Jumat sementara crypto tetap berjalan).
    const asOfByPair = Object.fromEntries(Object.entries(pairs).map(([k, v]) => [k, v.asOf]));
    const payload = {
        generatedAt: `${asOf}T00:00:00.000Z`,
        asOf,
        asOfByPair,
        source: `Yahoo Finance 1d OHLC (interval=1d&range=${RANGE}, max ${MAX_BARS} bar)`,
        symbols: Object.fromEntries(HTF_SYMBOLS.map(c => [c.pair, c.symbol])),
        pairs,
        errors
    };
    const next = JSON.stringify(payload) + '\n';
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
