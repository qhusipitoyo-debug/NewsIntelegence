import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const PRE_NEWS_FILE = 'data/prenews.json';
const PRE_NEWS_HOLD_MS = 7 * 24 * 60 * 60 * 1000;
const PRE_NEWS_WINDOW_MS = 2 * 60 * 60 * 1000;
const FOREX_SYMBOLS = ['EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD'];
const FOREX_PAIRS = [
  ['EUR/USD', 'EURUSD'],
  ['GBP/USD', 'GBPUSD'],
  ['USD/JPY', 'USDJPY'],
  ['USD/CHF', 'USDCHF'],
  ['AUD/USD', 'AUDUSD'],
  ['USD/CAD', 'USDCAD'],
  ['NZD/USD', 'NZDUSD'],
  ['GBP/JPY', 'GBPJPY'],
  ['EUR/JPY', 'EURJPY']
];

// OANDA adalah anchor harga live. Broker lain dipakai sebagai cross-check.
// GO Markets, FBS dan CMC Markets tidak membuka endpoint quote publik, jadi
// ketiganya tetap dicoba (kalau feed-nya tersedia) dan statusnya dilaporkan.
export const FOREX_FEEDS = [
  { id: 'OANDA', name: 'OANDA', prefix: 'OANDA' },
  { id: 'GOMARKETS', name: 'GO Markets', prefix: 'GOMARKETS' },
  { id: 'CMCMARKETS', name: 'CMC Markets', prefix: 'CMCMARKETS' },
  { id: 'FBS', name: 'FBS', prefix: 'FBS' },
  { id: 'SAXO', name: 'Saxo', prefix: 'SAXO' },
  { id: 'FOREXCOM', name: 'FOREX.com', prefix: 'FOREXCOM' },
  { id: 'CAPITALCOM', name: 'Capital.com', prefix: 'CAPITALCOM' },
  { id: 'PEPPERSTONE', name: 'Pepperstone', prefix: 'PEPPERSTONE' },
  { id: 'VANTAGE', name: 'Vantage', prefix: 'VANTAGE' },
  { id: 'FPMARKETS', name: 'FP Markets', prefix: 'FPMARKETS' },
  { id: 'EIGHTCAP', name: 'Eightcap', prefix: 'EIGHTCAP' },
  { id: 'BLACKBULL', name: 'BlackBull Markets', prefix: 'BLACKBULL' },
  { id: 'THINKMARKETS', name: 'ThinkMarkets', prefix: 'THINKMARKETS' },
  { id: 'SKILLING', name: 'Skilling', prefix: 'SKILLING' }
];
const INDICES = [
  { symbol: 'NAS100', name: 'Nasdaq 100', yahoo: '^NDX' },
  { symbol: 'US500', name: 'S&P 500', yahoo: '^GSPC' }
];

function normalizeMarket(market) {
  if (market && typeof market === 'object') {
    const gold = Number(market.price ?? market.gold);
    return {
      gold: Number.isFinite(gold) && gold > 0 ? gold : null,
      forex: market.forex && typeof market.forex === 'object' ? market.forex : null,
      crypto: market.crypto && typeof market.crypto === 'object' ? market.crypto : null,
      indices: market.indices && typeof market.indices === 'object' ? market.indices : null
    };
  }
  const gold = Number(market);
  return { gold: Number.isFinite(gold) && gold > 0 ? gold : null, forex: null, crypto: null, indices: null };
}

export function updatePreNewsStore(store, events, market, now = Date.now()) {
  const next = {};
  for (const [key, entry] of Object.entries(store || {})) {
    const capturedAt = entry && typeof entry === 'object' ? entry.capturedAt : null;
    const t = new Date(capturedAt || key.split('|')[0]).getTime();
    if (Number.isFinite(t) && now - t <= PRE_NEWS_HOLD_MS) next[key] = entry;
  }

  const { gold, forex, crypto, indices } = normalizeMarket(market);
  const hasPrices = gold != null || (forex && Object.keys(forex).length) || (crypto && Object.keys(crypto).length) || (indices && Object.keys(indices).length);
  if (!hasPrices) return next;

  for (const ev of events || []) {
    if (Number(ev.Importance) < 2) continue;
    const t = new Date(ev.Date).getTime();
    if (!Number.isFinite(t) || t <= now || t - now > PRE_NEWS_WINDOW_MS) continue;
    const key = `${ev.Date}|${ev.Event}`;
    const prevRaw = next[key] && typeof next[key] === 'object' ? next[key] : {};
    const prev = { ...prevRaw };
    if (prev.gold == null && prev.price != null) prev.gold = Number(prev.price);
    delete prev.price;
    const snap = { ...prev, capturedAt: new Date(now).toISOString() };
    if (gold != null) snap.gold = gold;
    if (forex) snap.forex = { ...(prev.forex || {}), ...forex };
    if (crypto) snap.crypto = { ...(prev.crypto || {}), ...crypto };
    if (indices) snap.indices = { ...(prev.indices || {}), ...indices };
    next[key] = snap;
  }
  return next;
}

async function readPreNews() {
  try {
    return JSON.parse(await fs.readFile(PRE_NEWS_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

async function readCalendar() {
  try {
    const raw = JSON.parse(await fs.readFile('data/calendar.json', 'utf8'));
    return Array.isArray(raw) ? raw : (Array.isArray(raw && raw.events) ? raw.events : []);
  } catch {
    return [];
  }
}

// ---- Backfill nilai Actual ----------------------------------------------------
// Export JSON/XML publik ForexFactory tidak memuat kolom actual sama sekali, jadi
// tanpa langkah ini kalender tidak pernah punya Actual dan sinyal pasca-rilis tidak
// bisa pernah terbentuk. Nilai Actual diambil dari kalender ekonomi TradingView
// (publik, tanpa API key) lalu dicocokkan ke event ForexFactory.
const TV_CALENDAR_URL = 'https://economic-calendar.tradingview.com/events';
// TradingView menolak permintaan (HTTP 403) tanpa origin/referer browser.
const TV_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  accept: 'application/json',
  origin: 'https://www.tradingview.com',
  referer: 'https://www.tradingview.com/'
};
const TV_CHUNK_MS = 2 * 24 * 60 * 60 * 1000;
const TV_TIME_TOLERANCE_MS = 5 * 60 * 1000;
const TV_MIN_TOKEN_SCORE = 0.6;
const TV_SCALE_TOLERANCE_LOG10 = 0.06;
// Angka acuan (Previous/Forecast) hanya dipakai sebagai pemecah seri yang sama;
// toleransi harus seketat pembulatan satu desimal, bukan selonggar deteksi skala.
const TV_REF_TOLERANCE_LOG10 = 0.005;

const COUNTRY_ADJECTIVES = [
  [/spain|spanish/i, 'ES'], [/germany|german|deutschland/i, 'DE'], [/france|french/i, 'FR'],
  [/italy|italian/i, 'IT'], [/eurozone|euro area|\beu\b/i, 'EU'],
  [/netherlands|holland|dutch/i, 'NL'], [/austria|austrian/i, 'AT'],
  [/canada|canadian/i, 'CA'], [/japan|japanese/i, 'JP'], [/australia|australian/i, 'AU'],
  [/new zealand|zealand|\bnz\b/i, 'NZ'], [/switzerland|swiss/i, 'CH'],
  [/britain|british|\buk\b|\bgbr?\b/i, 'GB'], [/united states|america|american|\bus\b|\busa\b/i, 'US'],
  [/mexico|mexican/i, 'MX'], [/china|chinese/i, 'CN'], [/india|indian/i, 'IN'],
  [/sweden|swedish/i, 'SE'], [/norway|norwegian/i, 'NO'], [/denmark|danish/i, 'DK']
];
const TOKEN_SYNONYM = {
  manufacturing: 'mfg', mfg: 'mfg', services: 'svs', service: 'svs',
  claims: 'claim', claim: 'claim', jobless: 'claim', unemployment: 'claim',
  sales: 'sale', sale: 'sale', payrolls: 'payroll', payroll: 'payroll', nfp: 'payroll',
  nonfarm: 'farm', 'non-farm': 'farm', mom: 'm', mo: 'm', mm: 'm',
  yoy: 'y', yy: 'y', y: 'y', qoq: 'q', qq: 'q', q: 'q',
  prelim: 'preliminary', flash: 'preliminary'
};
const TOKEN_NOISE = new Set([
  's', 'p', 'global', 'and', 'the', 'of', 'for', 'in', 'on', 'index', 'final', 'preliminary',
  'revised', 'annualized', 'm', 'y', 'q', 'adapted', 'separately', 'seasonally', 'adjusted',
  'unadjusted', 'sa', 'nsa', 'real', 'nominal', 'daylight', 'saving', 'time', 'shift', 'total'
]);

const firstNonEmpty = (...values) => values.find(v => String(v ?? '').trim() !== '') ?? '';

function isoZ(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function minuteOf(value) {
  const t = Date.parse(value);
  return Number.isFinite(t) ? Math.round(t / 6e4) * 6e4 : null;
}

export function eventIsoHint(title) {
  const raw = String(title || '');
  for (const [re, iso] of COUNTRY_ADJECTIVES) if (re.test(raw)) return iso;
  return '';
}

export function titleTokens(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(word => {
      const iso = COUNTRY_ADJECTIVES.find(([re]) => re.test(word));
      if (iso) return iso[1].toLowerCase();
      return TOKEN_SYNONYM[word] || word;
    })
    .filter(word => !TOKEN_NOISE.has(word));
}

export function titleKey(title) {
  return [...new Set(titleTokens(title))].sort().join(' ');
}

function parseAmount(text) {
  const raw = String(text ?? '').trim().replace(/,/g, '');
  if (!raw) return null;
  const m = raw.match(/^([+-]?\d*\.?\d+)\s*(K|M|B)?\s*(%?)$/i);
  if (!m) return null;
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return null;
  const suffix = (m[2] || '').toUpperCase();
  const mult = suffix === 'K' ? 1e3 : suffix === 'M' ? 1e6 : suffix === 'B' ? 1e9 : 1;
  return { num: base * mult, suffix, pct: m[3] === '%' };
}

function trimNumber(value) {
  const text = value.toFixed(2);
  return text.replace(/\.?0+$/, '');
}

function formatAmount(value, ref) {
  if (!Number.isFinite(value)) return '';
  let text;
  if (ref && ref.suffix === 'K') text = trimNumber(value / 1e3) + 'K';
  else if (ref && ref.suffix === 'M') text = trimNumber(value / 1e6) + 'M';
  else if (ref && ref.suffix === 'B') text = trimNumber(value / 1e9) + 'B';
  else text = Math.abs(value) >= 1000 ? String(Math.round(value)) : trimNumber(value);
  return ref && ref.pct ? `${text}%` : text;
}

// TradingView menandai beberapa rilis dalam ribu/juta sementara ForexFactory
// memakai angka penuh. Faktor skala dicari dari field acuan yang sama
// (Previous vs Previous, Forecast vs Forecast) supaya tidak menebak.
function scaleFactor(ffRef, tvRef) {
  if (!ffRef || !tvRef || !tvRef.num) return 1;
  const ratio = ffRef.num / tvRef.num;
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  for (const f of [1, 1e3, 1e6, 1e9, 1e-3, 1e-6, 1e-9]) {
    if (Math.abs(Math.log10(ratio / f)) < TV_SCALE_TOLERANCE_LOG10) return f;
  }
  return null;
}

function referencesFor(ffEvent) {
  if (String(ffEvent.Previous ?? '').trim()) return { field: 'previous', ref: parseAmount(ffEvent.Previous) };
  if (String(ffEvent.Forecast ?? '').trim()) return { field: 'forecast', ref: parseAmount(ffEvent.Forecast) };
  return { field: 'previous', ref: null };
}

// -> teks Actual siap tulis, atau '' bila nilai TV tidak bisa dipercaya.
export function mergedActual(ffEvent, candidate) {
  const rawText = String(candidate && candidate.actualText || '').trim();
  if (!rawText) return '';
  const { field, ref } = referencesFor(ffEvent);
  if (!ref) return rawText;
  const tvRef = parseAmount(field === 'forecast' ? candidate.forecastText : candidate.previousText);
  const factor = scaleFactor(ref, tvRef);
  if (factor === null) return '';
  const parsed = parseAmount(candidate.actualText);
  if (!parsed) return '';
  const value = parsed.num * factor;
  const scaleRef = tvRef ? tvRef.num * factor : ref.num;
  if (Math.abs(scaleRef) > 1e-9) {
    const jump = Math.abs(value / scaleRef);
    // Rasio wajar antar-dua-seri (mis. 314.5K vs 306.6K) hanya ~1; lompatan
    // puluhan kali lipat hampir selalu tabrakan satuan (TV 314.5 vs FF 306600).
    if (!(jump >= 0.2 && jump <= 5)) return '';
  }
  // Tanpa angka acuan, rasio 10^n tidak bisa dibuktikan: tolak, jangan mengarang.
  if (!tvRef && factor !== 1) return '';
  return formatAmount(value, ref);
}

function tvCandidate(event) {
  const actualText = firstNonEmpty(event && event.actualRaw, event && event.actual);
  if (String(actualText).trim() === '') return null;
  const minute = minuteOf(event && event.date);
  if (minute === null) return null;
  const currency = String(event && event.currency || '').toUpperCase();
  if (!currency) return null;
  const tokens = titleTokens(event.title || event.indicator);
  if (!tokens.length) return null;
  return {
    minute,
    currency,
    iso: String(event.country || '').toUpperCase(),
    title: String(event.title || ''),
    tokens: new Set(tokens),
    titleKey: titleKey(event.title || event.indicator),
    actualText: String(actualText).trim(),
    previousText: firstNonEmpty(event.previousRaw, event.previous),
    forecastText: firstNonEmpty(event.forecastRaw, event.forecast)
  };
}

export function buildActualIndex(tvEvents) {
  const buckets = new Map();
  const all = [];
  for (const event of tvEvents || []) {
    const candidate = tvCandidate(event);
    if (!candidate) continue;
    all.push(candidate);
    const key = `${candidate.minute}|${candidate.currency}|${candidate.titleKey}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(candidate);
    else buckets.set(key, [candidate]);
  }
  return { buckets, all };
}

function overlapScore(ffTokens, candidateTokens) {
  let common = 0;
  for (const token of ffTokens) if (candidateTokens.has(token)) common++;
  return common / Math.max(ffTokens.length, candidateTokens.size);
}

function qualifierConflict(ffTitle, tvTitle) {
  const ffFinal = /final/i.test(ffTitle);
  const tvFinal = /final/i.test(tvTitle);
  return ffFinal !== tvFinal;
}

// ForexFactory memakai kode mata uang dan menyebut agregat zona euro hanya "EUR",
// sedangkan TradingView memakai kode ISO negara. Tanpa kata sifat negara di judul,
// event EUR/USD harus datang dari agregat (EU/US), bukan negara bagian tetangga.
const AGGREGATE_ISO = { EUR: 'EU', USD: 'US', GBP: 'GB', JPY: 'JP', AUD: 'AU', NZD: 'NZ', CAD: 'CA' };

function refAgreement(ffEvent, candidate) {
  const { field, ref } = referencesFor(ffEvent);
  if (!ref) return false;
  const tvRef = parseAmount(field === 'forecast' ? candidate.forecastText : candidate.previousText);
  if (!tvRef || !tvRef.num) return false;
  return Math.abs(Math.log10(ref.num / tvRef.num)) < TV_REF_TOLERANCE_LOG10;
}

function rankCandidates(ffEvent, index, minute) {
  const ffTitle = String(ffEvent.Event || '');
  const tokens = titleTokens(ffTitle);
  const head = tokens[tokens.length - 1];
  if (!head) return [];
  const currency = String(ffEvent.Country || '').toUpperCase();
  const iso = eventIsoHint(ffTitle) || AGGREGATE_ISO[currency] || '';
  const exact = index.buckets.get(`${minute}|${currency}|${titleKey(ffTitle)}`);
  const pool = exact && exact.length ? exact : index.all;
  const ranked = [];
  for (const candidate of pool) {
    if (candidate.currency !== currency) continue;
    if (iso && candidate.iso !== iso) continue;
    if (Math.abs(candidate.minute - minute) > TV_TIME_TOLERANCE_MS) continue;
    if (!candidate.tokens.has(head)) continue;
    let score = overlapScore(tokens, candidate.tokens);
    if (qualifierConflict(ffTitle, candidate.title)) score -= 0.25;
    if (score < TV_MIN_TOKEN_SCORE) continue;
    if (refAgreement(ffEvent, candidate)) score += 0.15;
    ranked.push({ candidate, score, drift: Math.abs(candidate.minute - minute) });
  }
  return ranked.sort((a, b) => (b.score - a.score) || (a.drift - b.drift));
}

// Dua kandidat setara dengan angka Actual berbeda = ambigu; lebih baik tidak
// mengisi daripada memasang angka negara/seri yang salah ke kalender.
function pickCandidate(ffEvent, index, minute, stats) {
  const ranked = rankCandidates(ffEvent, index, minute);
  if (!ranked.length) return null;
  const best = ranked[0];
  const rival = ranked.slice(1).find(r => r.score >= best.score - 0.01
    && String(r.candidate.actualText).trim() !== String(best.candidate.actualText).trim());
  if (rival) {
    stats.ambiguous++;
    return null;
  }
  return best.candidate;
}

export function mergeActuals(ffEvents, tvEvents, now = Date.now()) {
  const index = buildActualIndex(tvEvents);
  const stats = {
    tvTotal: (tvEvents || []).length,
    tvUsable: index.all.length,
    matched: 0,
    filled: 0,
    rejected: 0,
    ambiguous: 0
  };
  const events = (ffEvents || []).map(event => {
    if (!event || String(event.Actual ?? '').trim()) return event;
    const minute = minuteOf(event.Date);
    // Event yang belum rilis tidak boleh punya Actual, meskipun sumber pihak
    // ketiga sudah memuat angka untuk periode sebelumnya.
    if (minute === null || minute > now) return event;
    const candidate = pickCandidate(event, index, minute, stats);
    if (!candidate) return event;
    stats.matched++;
    const actual = mergedActual(event, candidate);
    if (!actual) {
      stats.rejected++;
      return event;
    }
    stats.filled++;
    return { ...event, Actual: actual };
  });
  return { events, stats };
}

export async function fetchTradingViewActuals(fromMs, toMs, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const collected = [];
  for (let start = fromMs; start <= toMs; start += TV_CHUNK_MS) {
    const end = Math.min(start + TV_CHUNK_MS - 1000, toMs);
    const url = `${TV_CALENDAR_URL}?from=${isoZ(start)}&to=${isoZ(end)}&lang=en`;
    try {
      const response = await fetchImpl(url, { headers: TV_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
      if (!response || !response.ok) {
        console.error(`TradingView calendar HTTP ${response ? response.status : 'no-response'} untuk ${isoZ(start).slice(0, 10)} — Actual dibiarkan kosong.`);
        continue;
      }
      const payload = await response.json();
      const rows = payload && Array.isArray(payload.result) ? payload.result : [];
      if (!Array.isArray(payload && payload.result)) {
        console.error(`TradingView kalender tidak mengembalikan daftar event pada ${isoZ(start).slice(0, 10)}.`);
      }
      if (payload && Number.isFinite(payload.total) && payload.total !== rows.length) {
        console.error(`TradingView mengembalikan ${rows.length} dari ${payload.total} event pada ${isoZ(start).slice(0, 10)}.`);
      }
      collected.push(...rows);
    } catch (error) {
      console.error(`TradingView calendar gagal dibaca (${isoZ(start).slice(0, 10)}):`, error && error.message || error);
    }
  }
  return collected;
}

async function backfillActuals(events) {
  const stamps = events.map(e => Date.parse(e && e.Date)).filter(Number.isFinite);
  if (!stamps.length) return events;
  const dayMs = 24 * 60 * 60 * 1000;
  try {
    const tvEvents = await fetchTradingViewActuals(Math.min(...stamps) - dayMs, Math.max(...stamps) + dayMs);
    const { events: merged, stats } = mergeActuals(events, tvEvents);
    console.log(`Backfill Actual TradingView: ${stats.tvTotal} event dibaca, ${stats.tvUsable} punya Actual, ${stats.matched} cocok, ${stats.filled} terisi, ${stats.rejected} ditolak (skala), ${stats.ambiguous} ambigu.`);
    return merged;
  } catch (error) {
    console.error('Backfill Actual dilewati:', error && error.message || error);
    return events;
  }
}

// 1. AMBIL DATA KALENDER (ForexFactory)
async function fetchCalendar() {
  const urls = [
    'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
    'https://nfs.faireconomy.media/ff_calendar_nextweek.json'
  ];
  
  const batches = await Promise.all(urls.map(async u => {
    try {
      const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } });
      return r.ok ? await r.json() : [];
    } catch { return []; }
  }));

  const rank = { Low: 1, Medium: 2, High: 3 };
  
  // FILTER KANADA & MINYAK/ENERGI DITAMBAHKAN DI SINI
  const keywords = /fed|fomc|interest rate|inflation|cpi|pce|payroll|employment|unemployment|jobless|gdp|pmi|ism|retail sales|consumer confidence|jolts|durable goods|powell|treasury|oil|crude|energy|gas|opec|eia|rig|inventories|distillate|gasoline/i;
  const allowedCountries = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD'];

  const events = batches.flat()
    .filter(e => allowedCountries.includes(String(e.country || '').toUpperCase()) && keywords.test(e.title || ''))
    .map(e => ({
      Date: e.date,
      Event: e.title,
      Country: e.country,
      Importance: rank[e.impact] || 1,
      Forecast: e.forecast || '',
      Previous: e.previous || '',
      Actual: e.actual || ''
    }));

  if (!events.length) {
    console.error('ForexFactory mengembalikan 0 berita; calendar.json lama dipertahankan.');
    return readCalendar();
  }
  const merged = await backfillActuals(events);
  const payload = JSON.stringify(merged, null, 2);
  const previous = await fs.readFile('data/calendar.json', 'utf8').catch(() => '');
  if (payload !== previous) await fs.writeFile('data/calendar.json', payload);
  console.log('Berhasil menyimpan calendar.json dengan', merged.length, 'berita.');
  return merged;
}

// 2. AMBIL HARGA EMAS (Gold API)
async function fetchMarket() {
  try {
    const r = await fetch('https://api.gold-api.com/price/XAU');
    const j = await r.json();
    const price = Number(j.price);
    if (price > 0) {
      await fs.writeFile('data/market.json', JSON.stringify({
        generatedAt: new Date().toISOString(),
        symbol: "XAU/USD",
        price: String(price),
        change: "",
        percentChange: "",
        previousClose: ""
      }, null, 2));
      console.log('Berhasil menyimpan market.json dengan harga', price);
      return price;
    }
  } catch (e) {
    console.error('Gagal mengambil harga emas', e);
  }
  return null;
}

export function parseTradingViewForex(payload) {
  const feeds = {};
  const rows = payload && Array.isArray(payload.data) ? payload.data : [];
  for (const row of rows) {
    const [feed, symbol] = String(row && row.s || '').split(':');
    if (!feed || !symbol) continue;
    if (!FOREX_FEEDS.some(f => f.id === feed)) continue;
    const pair = FOREX_PAIRS.find(([, s]) => s === symbol);
    if (!pair) continue;
    const price = Number(row.d && row.d[1]);
    if (!Number.isFinite(price) || price <= 0) continue;
    const change = Number(row.d && row.d[2]);
    (feeds[feed] ||= {})[pair[0]] = {
      price,
      changePct: Number.isFinite(change) ? change : null
    };
  }
  return feeds;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function ratesFromQuotes(quotes) {
  const rates = { USD: 1 };
  for (const [pair, quote] of Object.entries(quotes || {})) {
    const price = Number(quote && quote.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    const [base, term] = pair.split('/');
    if (!base || !term) continue;
    if (term === 'USD' && base !== 'USD') rates[base] = 1 / price;
    else if (base === 'USD' && term !== 'USD') rates[term] = price;
  }
  return rates;
}

export function buildForexPayload(feeds, now = new Date()) {
  const quotes = {};
  for (const [pair] of FOREX_PAIRS) {
    const prices = [];
    const providers = {};
    for (const feed of FOREX_FEEDS) {
      const quote = feeds && feeds[feed.id] && feeds[feed.id][pair];
      const price = Number(quote && quote.price);
      if (!Number.isFinite(price) || price <= 0) continue;
      providers[feed.id] = price;
      prices.push(price);
    }
    if (!prices.length) continue;

    const oanda = Number(feeds && feeds.OANDA && feeds.OANDA[pair] && feeds.OANDA[pair].price);
    const primary = Number.isFinite(oanda) && oanda > 0;
    const anchor = primary ? oanda : median(prices);
    const references = prices.filter(p => Math.abs(p - anchor) > 1e-12);
    const crossCheckPct = references.length
      ? Math.max(...references.map(p => (Math.abs(p - anchor) / anchor) * 100))
      : 0;
    const change = feeds && feeds.OANDA && feeds.OANDA[pair] && feeds.OANDA[pair].changePct;

    quotes[pair] = {
      price: anchor,
      consensus: median(prices),
      source: primary ? 'OANDA' : 'broker consensus',
      changePct: Number.isFinite(Number(change)) ? Number(change) : null,
      crossCheckPct: Number(crossCheckPct.toFixed(3)),
      providers,
      updatedAt: now.toISOString()
    };
  }

  const providers = {};
  for (const feed of FOREX_FEEDS) {
    const count = feeds && feeds[feed.id] ? Object.keys(feeds[feed.id]).length : 0;
    providers[feed.id] = {
      name: feed.name,
      status: count > 0 ? 'ok' : 'unavailable',
      pairs: count
    };
  }

  return {
    generatedAt: now.toISOString(),
    source: 'OANDA (TradingView live)',
    anchor: 'OANDA',
    quotes,
    rates: ratesFromQuotes(quotes),
    providers
  };
}

async function fetchTradingViewForex() {
  const tickers = [];
  for (const feed of FOREX_FEEDS) {
    for (const [, symbol] of FOREX_PAIRS) tickers.push(`${feed.prefix}:${symbol}`);
  }
  const r = await fetch('https://scanner.tradingview.com/forex/scan', {
    method: 'POST',
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'content-type': 'application/json',
      origin: 'https://www.tradingview.com',
      referer: 'https://www.tradingview.com/'
    },
    body: JSON.stringify({
      symbols: { tickers },
      columns: ['name', 'close', 'change', 'update_mode']
    })
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return parseTradingViewForex(await r.json());
}

async function fetchForex() {
  try {
    const feeds = await fetchTradingViewForex();
    const payload = buildForexPayload(feeds);
    if (!Object.keys(payload.quotes).length) throw new Error('quote kosong');
    await fs.writeFile('data/forex.json', JSON.stringify(payload, null, 2));
    console.log('Berhasil menyimpan forex.json:', Object.entries(payload.quotes)
      .map(([pair, q]) => `${pair}=${q.price}`)
      .join(', '));
    return payload;
  } catch (e) {
    console.error('Gagal mengambil harga forex live (TradingView/OANDA)', e.message || e);
  }

  // Fallback terakhir: kurs harian er-api. Client akan memberi label "harian".
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD');
    const j = await r.json();
    const sourceRates = j && j.rates;
    if (!sourceRates) return null;
    const rates = { USD: 1 };
    for (const s of FOREX_SYMBOLS) {
      const v = Number(sourceRates[s]);
      if (Number.isFinite(v) && v > 0) rates[s] = v;
    }
    if (Object.keys(rates).length < 2) return null;
    const payload = {
      generatedAt: new Date().toISOString(),
      source: 'er-api (daily fallback)',
      anchor: 'er-api',
      quotes: {},
      rates,
      providers: {
        'er-api': { name: 'open.er-api.com', status: 'fallback', pairs: Object.keys(rates).length - 1 }
      }
    };
    await fs.writeFile('data/forex.json', JSON.stringify(payload, null, 2));
    console.log('forex.json memakai fallback kurs harian er-api');
    return payload;
  } catch (e) {
    console.error('Gagal mengambil kurs forex fallback', e);
    return null;
  }
}

async function fetchCrypto() {
  const sources = [
    {
      name: 'Binance',
      url: 'https://api.binance.com/api/v3/ticker/price?symbols=["BTCUSDT","ETHUSDT"]',
      parse(j, sourceName) {
        if (!Array.isArray(j)) return null;
        const btc = j.find(x => x.symbol === 'BTCUSDT');
        const eth = j.find(x => x.symbol === 'ETHUSDT');
        return valid({ 'BTC/USD': Number(btc && btc.price), 'ETH/USD': Number(eth && eth.price) }, sourceName);
      }
    },
    {
      name: 'CoinGecko',
      url: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd',
      parse(j, sourceName) {
        return valid({ 'BTC/USD': Number(j && j.bitcoin && j.bitcoin.usd), 'ETH/USD': Number(j && j.ethereum && j.ethereum.usd) }, sourceName);
      }
    }
  ];
  for (const source of sources) {
    try {
      const r = await fetch(source.url, { headers: { 'user-agent': 'Mozilla/5.0' } });
      const j = await r.json();
      const parsed = source.parse(j, source.name);
      if (parsed && parsed.rates) return parsed;
    } catch (e) {
      console.error(source.name + ' crypto gagal', e);
    }
  }
  return null;

  function valid(out, sourceName) {
    const rates = {
      'BTC/USD': Number(out && out['BTC/USD']),
      'ETH/USD': Number(out && out['ETH/USD'])
    };
    if (!(rates['BTC/USD'] > 0 && rates['ETH/USD'] > 0)) return null;
    return { rates, source: sourceName };
  }
}

async function fetchIndices() {
  const items = [];
  for (const cfg of INDICES) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(cfg.yahoo)}?interval=1m&range=1d`;
      const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const meta = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
      if (!meta) throw new Error('meta missing');
      const price = Number(meta.regularMarketPrice);
      const previousClose = Number(meta.chartPreviousClose ?? meta.previousClose);
      if (!Number.isFinite(price) || price <= 0) throw new Error('price missing');
      items.push({
        symbol: cfg.symbol,
        name: cfg.name,
        yahoo: cfg.yahoo,
        price,
        previousClose: Number.isFinite(previousClose) && previousClose > 0 ? previousClose : null,
        changePct: Number.isFinite(previousClose) && previousClose > 0
          ? Number((((price - previousClose) / previousClose) * 100).toFixed(2))
          : null
      });
    } catch (e) {
      console.error('Gagal mengambil index', cfg.symbol, e.message || e);
    }
  }
  if (!items.length) return null;
  await fs.writeFile('data/indices.json', JSON.stringify({
    generatedAt: new Date().toISOString(),
    items
  }, null, 2));
  console.log('Berhasil menyimpan indices.json:', items.map(x => `${x.symbol}=${x.price}`).join(', '));
  return items;
}

const MARKET_SYMBOLS = [
  // Catatan kalibrasi: bar emas memakai futures GC=F karena Yahoo tidak
  // menyediakan historis 1 menit untuk spot XAUUSD=X (404). Bar GC=F hanya
  // dipakai untuk mengukur PERSENTASE reaksi/momentum dan ATR — bukan harga
  // entry. Harga entry dikalibrasi ke bid/ask broker asli lewat MT5 bridge
  // (scripts/mt5_quotes.py, termasuk XAU/USD) dan disimpan di forex-broker.json.
  { pair: 'EUR/USD', yahoo: 'EURUSD=X' },
  { pair: 'GBP/USD', yahoo: 'GBPUSD=X' },
  { pair: 'USD/JPY', yahoo: 'USDJPY=X' },
  { pair: 'USD/CHF', yahoo: 'USDCHF=X' },
  { pair: 'AUD/USD', yahoo: 'AUDUSD=X' },
  { pair: 'USD/CAD', yahoo: 'USDCAD=X' },
  { pair: 'NZD/USD', yahoo: 'NZDUSD=X' },
  { pair: 'GBP/JPY', yahoo: 'GBPJPY=X' },
  { pair: 'EUR/JPY', yahoo: 'EURJPY=X' },
  { pair: 'XAU/USD', yahoo: 'GC=F' },
  { pair: 'BTC/USD', yahoo: 'BTC-USD' },
  { pair: 'ETH/USD', yahoo: 'ETH-USD' },
  { pair: 'NAS100', yahoo: '^NDX', reactionFrom: 'NQ=F' },
  { pair: 'US500', yahoo: '^GSPC', reactionFrom: 'ES=F' }
];
const MARKETS_FILE = 'data/markets.json';
const CRYPTO_FILE = 'data/crypto.json';
const MARKET_BARS = 270;

// Bar 1 menit ^NDX/^GSPC hanya tersedia 13:30–21:00 UTC, jadi rilis pada sesi Asia/Eropa
// tidak pernah bisa diukur dari indeks spot. Futures-nya (NQ=F/ES=F) jalan hampir 24 jam
// dan persentase geraknya sama, jadi reaksi pasca-rilis indeks diukur dari sana.
const REACTION_BAR_SOURCES = MARKET_SYMBOLS
  .filter(cfg => cfg.reactionFrom)
  .map(cfg => ({ pair: cfg.pair, yahoo: cfg.reactionFrom }));

export async function fetchReactionBars(sources = REACTION_BAR_SOURCES, { fetchImpl = fetch } = {}) {
  const bars = {};
  await Promise.all(sources.map(async cfg => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(cfg.yahoo)}?interval=1m&range=5d`;
    try {
      const r = await fetchImpl(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
      if (!r || !r.ok) throw new Error(`HTTP ${r && r.status}`);
      const rows = barsFromYahoo(await r.json());
      if (rows && rows.bars && rows.bars.length) bars[cfg.pair] = { bars: rows.bars, via: cfg.yahoo };
    } catch (e) {
      console.error('Gagal mengambil bar reaksi', cfg.pair, e.message || e);
    }
  }));
  return bars;
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function barsFromYahoo(payload) {
  const chart = payload && payload.chart && payload.chart.result && payload.chart.result[0];
  const meta = chart && chart.meta;
  const timestamps = Array.isArray(chart && chart.timestamp) ? chart.timestamp : [];
  const quote = chart && chart.indicators && chart.indicators.quote && chart.indicators.quote[0];
  const bars = [];
  for (let i = 0; i < timestamps.length; i++) {
    const k = Math.floor(Number(timestamps[i]) / 60);
    const open = finiteNumber(quote && quote.open && quote.open[i]);
    const high = finiteNumber(quote && quote.high && quote.high[i]);
    const low = finiteNumber(quote && quote.low && quote.low[i]);
    const close = finiteNumber(quote && quote.close && quote.close[i]);
    if (!open || !high || !low || !close) continue;
    bars.push({ k, o: open, h: high, l: low, c: close });
  }
  return { meta, bars: bars.slice(-MARKET_BARS) };
}

export function buildMarketPayload({ price, forex, crypto, yahooByPair, now = new Date() }) {
  const quotes = { ...(forex || {}) };
  if (finiteNumber(price) && price > 0) quotes['XAU/USD'] = { price, source: 'gold-api', changePct: null };
  if (crypto && crypto.rates) {
    for (const [pair, value] of Object.entries(crypto.rates)) {
      if (finiteNumber(value) && value > 0) quotes[pair] = { price: value, source: crypto.source, changePct: null };
    }
  }

  const pairs = {};
  for (const cfg of MARKET_SYMBOLS) {
    const yahoo = yahooByPair && yahooByPair[cfg.pair];
    const bars = yahoo ? yahoo.bars : [];
    const meta = yahoo ? yahoo.meta : null;
    const quote = quotes[cfg.pair] || {};
    const current = finiteNumber(quote.price)
      || finiteNumber(meta && meta.regularMarketPrice)
      || (bars.length ? bars[bars.length - 1].c : null);
    if (!(current > 0)) continue;
    pairs[cfg.pair] = {
      price: current,
      bid: current,
      ask: current,
      spread: 0,
      source: quote.source || 'Yahoo Finance',
      changePct: finiteNumber(quote.changePct) ?? finiteNumber(meta && meta.regularMarketChangePercent),
      previousClose: finiteNumber(meta && (meta.previousClose ?? meta.chartPreviousClose)),
      bars
    };
  }
  return {
    generatedAt: now.toISOString(),
    source: 'OANDA/gold-api/Binance or CoinGecko; Yahoo Finance 1m history; synthetic 0 spread',
    anchor: 'aiterminaltrading',
    staleAfterSec: 1800,
    pairs
  };
}

async function fetchMarkets({ price, forexData, cryptoData }) {
  const yahooByPair = {};
  await Promise.all(MARKET_SYMBOLS.map(async cfg => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(cfg.yahoo)}?interval=1m&range=5d`;
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      yahooByPair[cfg.pair] = barsFromYahoo(await r.json());
    } catch (e) {
      console.error('Gagal mengambil history 1m', cfg.pair, e.message || e);
      yahooByPair[cfg.pair] = { meta: null, bars: [] };
    }
  }));
  const forexQuotes = forexData && forexData.quotes ? forexData.quotes : {};
  const payload = buildMarketPayload({
    price,
    forex: forexQuotes,
    crypto: cryptoData,
    yahooByPair,
    now: new Date()
  });
  await fs.writeFile(MARKETS_FILE, JSON.stringify(payload, null, 2));
  if (cryptoData && cryptoData.rates) {
    await fs.writeFile(CRYPTO_FILE, JSON.stringify({
      generatedAt: payload.generatedAt,
      source: cryptoData.source,
      pairs: cryptoData.rates
    }, null, 2));
  }
  console.log('Berhasil menyimpan markets.json:', Object.keys(payload.pairs).join(', '));
  return payload;
}

// ---- Reaksi harga pasca-rilis -------------------------------------------------
// Tidak semua indikator publishes Actual (actual S&P Global PMI tidak tersedia di
// sumber gratis mana pun). Untuk event tanpa Actual, arah pasca-rilis diukur dari
// bar 1 menit yang sudah diambil fetchMarkets(): close terakhir sebelum rilis
// dibandingkan close pada window settle..horizon sesudahnya.
const REACTION_FILE = 'data/reaction.json';
const REACTION_SETTLE_MIN = 15;
const REACTION_HORIZON_MIN = 45;
const REACTION_MIN_MOVE_PCT = 0.03;
const REACTION_HOLD_MS = 6 * 60 * 60 * 1000;

export function reactionFromBars(bars, releaseMs, {
  settleMin = REACTION_SETTLE_MIN,
  horizonMin = REACTION_HORIZON_MIN,
  minMovePct = REACTION_MIN_MOVE_PCT,
  maxBaseAgeMin = 30
} = {}) {
  const release = Number(releaseMs);
  if (!Number.isFinite(release)) return null;
  const rows = (bars || [])
    .map(bar => ({ t: Number(bar && bar.k) * 60000, c: Number(bar && bar.c) }))
    .filter(row => Number.isFinite(row.t) && Number.isFinite(row.c) && row.c > 0)
    .sort((a, b) => a.t - b.t);
  if (!rows.length) return null;

  let base = null;
  for (const row of rows) {
    if (row.t <= release) base = row;
    else break;
  }
  if (!base || release - base.t > maxBaseAgeMin * 60000) return null;

  let last = null;
  for (const row of rows) {
    if (row.t >= release + settleMin * 60000 && row.t <= release + horizonMin * 60000) last = row;
  }
  if (!last || last.t <= base.t) return null;

  const movePct = Number(((last.c - base.c) / base.c * 100).toFixed(3));
  return {
    baseClose: base.c,
    lastClose: last.c,
    movePct,
    dir: Math.abs(movePct) < minMovePct ? null : (movePct > 0 ? 'long' : 'short'),
    minutes: Math.round((last.t - release) / 60000)
  };
}

export function buildReactionPayload(events, markets, now = Date.now(), holdMs = REACTION_HOLD_MS, extraBars = {}) {
  const pairs = markets && markets.pairs;
  if (!pairs) return { generatedAt: null, events: {} };
  const keyed = {};
  for (const event of events || []) {
    const releasedAt = Date.parse(event && event.Date);
    if (!Number.isFinite(releasedAt) || releasedAt > now || now - releasedAt > holdMs) continue;
    const reaction = {};
    for (const [pair, cfg] of Object.entries(pairs)) {
      // Bar milik sendiri diprioritaskan; sumber cadangan (mis. NQ=F untuk NAS100)
      // hanya dipakai kalau bar sendiri tidak menutupi rilis.
      const sources = [cfg, extraBars && extraBars[pair]];
      for (const source of sources) {
        const measured = reactionFromBars(source && source.bars, releasedAt);
        if (!measured) continue;
        reaction[pair] = source !== cfg && source.via ? { ...measured, via: source.via } : measured;
        break;
      }
    }
    if (Object.keys(reaction).length) {
      keyed[`${event.Date}|${event.Event}`] = { releasedAt: new Date(releasedAt).toISOString(), pairs: reaction };
    }
  }
  return { generatedAt: (markets && markets.generatedAt) || new Date(now).toISOString(), events: keyed };
}

export async function main() {
  const events = await fetchCalendar();
  const [price, forexData, cryptoData, indices] = await Promise.all([fetchMarket(), fetchForex(), fetchCrypto(), fetchIndices()]);
  const markets = await fetchMarkets({ price, forexData, cryptoData });
  const extraBars = await fetchReactionBars();
  const reaction = buildReactionPayload(events, markets, Date.now(), REACTION_HOLD_MS, extraBars);
  await fs.writeFile(REACTION_FILE, JSON.stringify(reaction, null, 2));
  console.log('Reaksi harga pasca-rilis tersimpan:', Object.keys(reaction.events).length, 'event.');
  const forex = forexData && forexData.rates;
  const crypto = cryptoData && cryptoData.rates;
  const indexPrices = indices
    ? Object.fromEntries(indices.map(x => [x.symbol, x.price]))
    : null;
  const store = updatePreNewsStore(await readPreNews(), events, { price, forex, crypto, indices: indexPrices });
  await fs.writeFile(PRE_NEWS_FILE, JSON.stringify(store, null, 2));
  console.log('Snapshot harga pra-news tersimpan:', Object.keys(store).length, 'event.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
