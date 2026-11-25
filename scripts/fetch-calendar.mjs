import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import dns from 'node:dns';

try {
  dns.setDefaultResultOrder('ipv4first');
} catch {}

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

// Gabungkan baris kembar (FF + TradingView mencantumkan rilis yang sama beberapa
// menit terpisah, mis. "ADP Weekly Employment Change" 08:14 & 08:15). Pemenang =
// baris dengan data terlengkap (Actual > Forecast > Previous, lalu importance);
// kolom yang kosong diisi dari baris yang kalah supaya tidak ada data yang hilang.
export function dedupeCalendarEvents(events) {
  const list = (Array.isArray(events) ? events : []).filter(Boolean);
  const out = [];
  const score = e => (String(e.Actual ?? '').trim() ? 4 : 0) + (String(e.Forecast ?? '').trim() ? 2 : 0) + (String(e.Previous ?? '').trim() ? 1 : 0) + ((+e.Importance || 1) >= 3 ? 0.5 : 0);
  for (const ev of list) {
    const t = minuteOf(ev.Date);
    let twinIdx = -1;
    if (t !== null) {
      twinIdx = out.findIndex(o => {
        const ot = minuteOf(o.Date);
        return ot !== null && Math.abs(ot - t) <= TV_TIME_TOLERANCE_MS && areEventsMatching(ev, o);
      });
    }
    if (twinIdx < 0) { out.push({ ...ev }); continue; }
    const cur = out[twinIdx];
    const keep = score(ev) > score(cur) ? ev : cur;
    const drop = keep === ev ? cur : ev;
    out[twinIdx] = {
      ...keep,
      Forecast: keep.Forecast || drop.Forecast || '',
      Previous: keep.Previous || drop.Previous || '',
      Actual: keep.Actual || drop.Actual || '',
      Importance: Math.max(+keep.Importance || 1, +drop.Importance || 1),
      Event: keep.Event || drop.Event,
      Date: keep.Date || drop.Date
    };
  }
  return out;
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
// Konsep (sinonim) dipakai di KEDUA sisi judul (FF dan TV), jadi pemetaan ini
// menjembatani penamaan yang berbeda: FF "Core CPI m/m" ↔ TV "Core Inflation
// Rate MoM", FF "Non-Farm Employment Change" ↔ TV "Nonfarm Payrolls", dst.
const TOKEN_SYNONYM = {
  manufacturing: 'mfg', mfg: 'mfg', services: 'svs', service: 'svs',
  claims: 'claim', claim: 'claim', jobless: 'claim', unemployment: 'claim',
  sales: 'sale', sale: 'sale', payrolls: 'employ', payroll: 'employ', nfp: 'employ',
  employment: 'employ', employed: 'employ', nonfarm: 'farm', 'non-farm': 'farm',
  cpi: 'cpi', inflation: 'cpi', ppi: 'ppi', producer: 'ppi', pce: 'pce', consumption: 'pce',
  mom: 'm', mo: 'm', mm: 'm',
  yoy: 'y', yy: 'y', y: 'y', qoq: 'q', qq: 'q', q: 'q',
  prelim: 'preliminary', flash: 'preliminary'
};
const TOKEN_NOISE = new Set([
  's', 'p', 'global', 'and', 'the', 'of', 'for', 'in', 'on', 'index', 'final', 'preliminary',
  'revised', 'annualized', 'adapted', 'separately', 'seasonally', 'adjusted',
  'unadjusted', 'sa', 'nsa', 'real', 'nominal', 'daylight', 'saving', 'time', 'shift', 'total',
  // "initial" hanya membedakan initial vs continued claims; FF tidak memakai kata
  // itu di "Unemployment Claims", jadi dihilangkan agar pasangan itu tetap cocok.
  'initial', 'change'
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
    // "Non-Manufacturing" adalah nama lama survei jasa ISM; samakan dengan
    // "Services" supaya pasangan FF/TV tetap cocok dan seri ini tidak pecah dua.
    .replace(/non[-\s]?manufactur(ing)?/g, 'services')
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

// Qualifier pembeda seri: bila satu judul memuat penanda ini dan judul lain tidak,
// keduanya BUKAN rilis yang sama (mis. "GDP Growth Rate" vs "GDP Price Index" vs
// "GDP Sales", atau "Durable Goods Orders" vs "ex Defense"). Tanpa penanda ini,
// overlap token ≥ 0.6 menyatukan seri yang berbeda dan event penting seperti
// GDP Growth Rate tertelan diam-diam ke baris GDP Price Index.
const QUALIFIER_PATTERNS = [
  /\bcore\b/i, /\btrimmed\b/i, /\bmedian\b/i, /\bfinal\b/i, /\b(flash|prelim|preliminary)\b/i,
  /\bgrowth\b/i, /\bprice\b/i, /\bsales\b/i, /\bspending\b/i, /\bincome\b/i, /\borders\b/i,
  /\bex\b/i, /\bexcl(uding)?\b/i, /\bdefense\b/i, /\btransp(ort)?\b/i, /\bautos?\b/i,
  /\b(adv|advance)\b/i, /\bopenings\b/i, /\bquits\b/i, /\baverage\b/i, /\bgas\b/i,
  /\bnatural\b/i, /\bcrude\b/i, /\b(employment|payrolls?)\b/i, /\bbusiness\b/i, /\bweekly\b/i, /\bhourly\b/i,
  /\bprices?\b/i, /\byoy\b/i, /\bmom\b/i, /\bqoq\b/i
];
// Produk manufaktur vs jasa: dinormalisasi dulu ("Non-Manufacturing" == Services)
// supaya FF "ISM Non-Manufacturing PMI" tetap dikenali sebagai seri yang sama dengan
// TV "ISM Services PMI", tetapi tidak pernah menyatu dengan "ISM Manufacturing PMI".
const QUALIFIER_MFG_SVS = [/\bmanufacturing\b/i, /\bservices?\b/i];

function qualifierConflict(ffTitle, tvTitle) {
  const norm = s => String(s || '').toLowerCase()
    .replace(/non[-\s]?manufactur(ing)?/g, 'services')
    // Samakan penulisan periode: FF "m/m"/"y/y"/"q/q" == TV "MoM"/"YoY"/"QoQ".
    .replace(/\bm\/m\b/g, 'mom').replace(/\by\/y\b/g, 'yoy').replace(/\bq\/q\b/g, 'qoq');
  const a = norm(ffTitle), b = norm(tvTitle);
  const aFinal = /final/i.test(a);
  const bFinal = /final/i.test(b);
  if (aFinal !== bFinal) return true;
  for (const re of QUALIFIER_PATTERNS) {
    if (re.test(a) !== re.test(b)) return true;
  }
  for (const re of QUALIFIER_MFG_SVS) {
    if (re.test(a) !== re.test(b)) return true;
  }
  return false;
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

export function rankCandidates(ffEvent, index, minute) {
  const ffTitle = String(ffEvent.Event || '');
  const tokens = titleTokens(ffTitle);
  // Penjaga "head token" dilepas: skor overlap >= 0.6 sudah menjamin minimal
  // satu token konsep bersama, dan penjaga lama justru membuang pasangan valid
  // seperti FF "CPI m/m" <-> TV "Inflation Rate MoM" karena kata terakhir FF
  // ('cpi') tidak ada di judul TV.
  const currency = String(ffEvent.Country || '').toUpperCase();
  const iso = eventIsoHint(ffTitle) || AGGREGATE_ISO[currency] || '';
  const exact = index.buckets.get(`${minute}|${currency}|${titleKey(ffTitle)}`);
  const pool = exact && exact.length ? exact : index.all;
  const ranked = [];
  for (const candidate of pool) {
    if (candidate.currency !== currency) continue;
    if (iso && candidate.iso !== iso) continue;
    if (Math.abs(candidate.minute - minute) > TV_TIME_TOLERANCE_MS) continue;
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
  const merged = (ffEvents || []).map(event => {
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
  // Pass 2: ForexFactory kadang mencantumkan rilis yang sama dua kali dengan
  // menit beda 1 (mis. "ADP Weekly Employment Change" 08:14 & 08:15) tetapi
  // kolom Previous-nya dari minggu berbeda, sehingga pass skala menolak salah
  // satunya. Baris kembar (judul + negara sama, menit berdekatan) mewarisi
  // Actual dari saudaranya yang sudah terisi — ini rilis yang sama, bukan seri
  // data yang berbeda.
  const events = merged.map(event => {
    if (!event || String(event.Actual ?? '').trim()) return event;
    const minute = minuteOf(event.Date);
    if (minute === null || minute > now) return event;
    const twin = merged.find(o => o !== event
      && String(o.Actual ?? '').trim()
      && String(o.Event || '') === String(event.Event || '')
      && String(o.Country || '').toUpperCase() === String(event.Country || '').toUpperCase()
      && Math.abs((minuteOf(o.Date) ?? Infinity) - minute) <= TV_TIME_TOLERANCE_MS);
    if (!twin) return event;
    stats.filled++;
    return { ...event, Actual: twin.Actual };
  });
  return { events, stats };
}

export async function fetchTradingViewActuals(fromMs, toMs, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const collected = [];
  for (let start = fromMs; start <= toMs; start += TV_CHUNK_MS) {
    const end = Math.min(start + TV_CHUNK_MS - 1000, toMs);
    // Jendela nol (from == to) membuat TradingView menjawab tanpa `result`;
    // chunk seperti itu tidak valid, jadi dihentikan saja.
    if (end < start) break;
    const url = `${TV_CALENDAR_URL}?from=${isoZ(start)}&to=${isoZ(end)}&lang=en`;
    try {
      const response = await fetchImpl(url, { headers: TV_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
      if (!response || !response.ok) {
        console.error(`TradingView calendar HTTP ${response ? response.status : 'no-response'} untuk ${isoZ(start).slice(0, 10)} — Actual dibiarkan kosong.`);
        continue;
      }
      const payload = await response.json();
      const rows = payload && Array.isArray(payload.result) ? payload.result : [];
      if (!Array.isArray(payload && payload.result) && start <= Date.now()) {
        // Chunk yang belum terjadi (next week) memang wajarnya kosong — bukan error.
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

export async function fetchTradingViewCalendar(fromMs, toMs, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const collected = [];
  const chunkMs = 7 * 24 * 60 * 60 * 1000;
  for (let start = fromMs; start < toMs; start += chunkMs) {
    const end = Math.min(start + chunkMs, toMs);
    const url = `${TV_CALENDAR_URL}?from=${isoZ(start)}&to=${isoZ(end)}&lang=en`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetchImpl(url, { headers: TV_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
        if (!response || !response.ok) {
          console.error(`TradingView calendar HTTP ${response ? response.status : 'no-response'} (${isoZ(start).slice(0, 10)})`);
          break;
        }
        const payload = await response.json();
        const rows = payload && Array.isArray(payload.result) ? payload.result : [];
        collected.push(...rows);
        break;
      } catch (error) {
        if (attempt === 2) {
          console.error(`TradingView calendar chunk gagal (${isoZ(start).slice(0, 10)}):`, error && error.message || error);
        } else {
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }
  }
  return collected;
}

export function parseTradingViewEvents(tvRows) {
  const keywords = /fed|fomc|interest rate|inflation|cpi|pce|ppi|adp|payroll|employment|unemployment|jobless|gdp|pmi|ism|retail sales|consumer confidence|jolts|durable goods|powell|treasury|oil|crude|energy|gas|opec|eia|rig|inventories|distillate|gasoline|home sales|housing|building permits|industrial production|manufacturing|trade balance|ecb|boj|boe|rba|boc|rbnz/i;
  const allowedCurrencies = new Set(['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD']);

  function trimNumber(v) {
    return Number(v).toFixed(2).replace(/\.?0+$/, '');
  }

  function formatTvVal(val, unit, title) {
    if (val === null || val === undefined || val === '') return '';
    const num = Number(val);
    if (!Number.isFinite(num)) return String(val).trim();
    if (unit === '%' || (!unit && /inflation|cpi|pce|ppi|rate|yield|growth|mom|yoy|qoq/i.test(title) && Math.abs(num) <= 100)) {
      return trimNumber(num) + '%';
    }
    if (unit === 'K' || (!unit && /claims|jobless|payroll|nonfarm|\badp\b/i.test(title) && Math.abs(num) < 10000 && Math.abs(num) > 0)) {
      return trimNumber(num) + 'K';
    }
    if (unit === 'M') return trimNumber(num) + 'M';
    if (unit === 'B') return trimNumber(num) + 'B';
    if (Math.abs(num) >= 1e9) return trimNumber(num / 1e9) + 'B';
    if (Math.abs(num) >= 1e6) return trimNumber(num / 1e6) + 'M';
    if (Math.abs(num) >= 1e3 && unit !== '%') return trimNumber(num / 1e3) + 'K';
    return trimNumber(num);
  }

  const events = [];
  const seen = new Set();
  for (const r of tvRows || []) {
    const cur = String(r && r.currency || '').toUpperCase();
    if (!allowedCurrencies.has(cur)) continue;
    const title = String(r && r.title || '').trim();
    if (!title) continue;
    const imp = Number(r.importance);
    if (imp < 0 && !keywords.test(title)) continue;
    const rank = imp === 1 ? 3 : (imp === 0 ? 2 : 1);
    // Wajib RFC3339 dengan offset/Z. Tanpa zone, Date.parse memakai TZ lokal
    // mesin CI dan bisa menggeser rilis satu jam saat DST AS/UK berubah.
    const date = String(r.date || '').trim();
    const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(date);
    if (!date || !hasZone || isNaN(Date.parse(date))) continue;

    const dedupeKey = `${date}|${cur}|${title.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    events.push({
      Date: date,
      Event: title,
      Country: cur,
      Importance: rank,
      Forecast: formatTvVal(r.forecast ?? r.forecastRaw, r.unit, title),
      Previous: formatTvVal(r.previous ?? r.previousRaw, r.unit, title),
      Actual: formatTvVal(r.actual ?? r.actualRaw, r.unit, title)
    });
  }
  return events;
}

export function areEventsMatching(a, b) {
  if (!a || !b) return false;
  const aCur = String(a.Country || '').toUpperCase();
  const bCur = String(b.Country || '').toUpperCase();
  if (aCur !== bCur) return false;

  const aMs = minuteOf(a.Date);
  const bMs = minuteOf(b.Date);
  if (aMs === null || bMs === null) return false;
  if (Math.abs(aMs - bMs) > TV_TIME_TOLERANCE_MS) return false;

  const aTitle = String(a.Event || '').toLowerCase();
  const bTitle = String(b.Event || '').toLowerCase();
  if (aTitle === bTitle) return true;

  // Qualifier checks: seri berbeda di menit yang sama (Core vs Headline, Final vs
  // Flash, Growth vs Price vs Sales, ex- vs total) tidak boleh disatukan.
  if (qualifierConflict(aTitle, bTitle)) return false;

  const aTokens = titleTokens(a.Event);
  const bTokens = new Set(titleTokens(b.Event));
  return overlapScore(aTokens, bTokens) >= 0.6;
}

async function backfillActuals(events, now = Date.now()) {
  const pastStamps = events
    .map(e => Date.parse(e && e.Date))
    .filter(t => Number.isFinite(t) && t <= now + 5 * 60 * 1000);
  if (!pastStamps.length) return events;
  const dayMs = 24 * 60 * 60 * 1000;
  try {
    const fromMs = Math.min(...pastStamps) - dayMs;
    const toMs = Math.min(now + 60 * 1000, Math.max(...pastStamps) + 5 * 60 * 1000);
    const tvEvents = await fetchTradingViewActuals(fromMs, toMs);
    const { events: merged, stats } = mergeActuals(events, tvEvents, now);
    console.log(`Backfill Actual TradingView: ${stats.tvTotal} event dibaca, ${stats.tvUsable} punya Actual, ${stats.matched} cocok, ${stats.filled} terisi, ${stats.rejected} ditolak (skala), ${stats.ambiguous} ambigu.`);
    return merged;
  } catch (error) {
    console.error('Backfill Actual dilewati:', error && error.message || error);
    return events;
  }
}

// 1. AMBIL DATA KALENDER (ForexFactory + TradingView realtime minggu depan & bulan depan)
export async function fetchCalendar() {
  const now = Date.now();
  const existing = await readCalendar();

  // Pertahankan berita 60 hari ke belakang agar rilis besar (NFP, CPI, PCE, FOMC)
  // yang sebelumnya hilang dari kalender tidak terjatuh saat refresh berikutnya.
  // Jendela 60 hari juga dipakai untuk meng-INSERT event TradingView yang pernah
  // rilis tetapi belum ada di kalender (lihat langkah B2).
  const pastHoldMs = 60 * 24 * 60 * 60 * 1000;
  const baseEvents = existing.filter(e => {
    const t = Date.parse(e && e.Date);
    return Number.isFinite(t) && t >= now - pastHoldMs;
  });

  // A. Ambil dari ForexFactory (thisweek & nextweek jika tersedia)
  const ffUrls = [
    'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
    'https://nfs.faireconomy.media/ff_calendar_nextweek.json'
  ];
  const rank = { Low: 1, Medium: 2, High: 3 };
  const keywords = /fed|fomc|interest rate|inflation|cpi|pce|ppi|adp|payroll|employment|unemployment|jobless|gdp|pmi|ism|retail sales|consumer confidence|jolts|durable goods|powell|treasury|oil|crude|energy|gas|opec|eia|rig|inventories|distillate|gasoline|home sales|housing|building permits|industrial production|manufacturing|trade balance|ecb|boj|boe|rba|boc|rbnz/i;
  const allowedCountries = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD'];

  const ffBatches = await Promise.all(ffUrls.map(async u => {
    try {
      const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
      return r.ok ? await r.json() : [];
    } catch { return []; }
  }));

  const ffEvents = ffBatches.flat()
    .filter(e => allowedCountries.includes(String(e.country || '').toUpperCase()) && (e.impact === 'High' || e.impact === 'Medium' || keywords.test(e.title || '')))
    .map(e => ({
      Date: e.date,
      Event: e.title,
      Country: e.country,
      Importance: rank[e.impact] || 1,
      Forecast: e.forecast || '',
      Previous: e.previous || '',
      Actual: e.actual || ''
    }));

  // B. Ambil dari TradingView untuk minggu depan & bulan depan (35 hari ke depan)
  let tvEvents = [];
  try {
    const tvFrom = now - 24 * 60 * 60 * 1000;
    const tvTo = now + 35 * 24 * 60 * 60 * 1000;
    const tvRows = await fetchTradingViewCalendar(tvFrom, tvTo);
    tvEvents = parseTradingViewEvents(tvRows);
  } catch (err) {
    console.error('TradingView future calendar dilewati:', err && err.message || err);
  }

  // C. Gabungkan data secara cerdas (ForexFactory + TradingView + Riwayat)
  let merged = [...baseEvents];

  // 1. Masukkan / perbarui dari ForexFactory
  for (const fe of ffEvents) {
    const idx = merged.findIndex(m => areEventsMatching(fe, m));
    if (idx >= 0) {
      const existingEv = merged[idx];
      merged[idx] = {
        ...existingEv,
        Event: fe.Event,
        Importance: fe.Importance,
        Forecast: fe.Forecast || existingEv.Forecast || '',
        Previous: fe.Previous || existingEv.Previous || '',
        Actual: existingEv.Actual || fe.Actual || ''
      };
    } else {
      merged.push(fe);
    }
  }

  // 2. Masukkan berita masa depan dari TradingView untuk minggu depan & bulan depan
  let tvAdded = 0;
  for (const te of tvEvents) {
    const idx = merged.findIndex(m => areEventsMatching(te, m));
    if (idx >= 0) {
      const existingEv = merged[idx];
      if (!existingEv.Forecast && te.Forecast) existingEv.Forecast = te.Forecast;
      if (!existingEv.Previous && te.Previous) existingEv.Previous = te.Previous;
      if (!existingEv.Actual && te.Actual && Date.parse(te.Date) <= now) existingEv.Actual = te.Actual;
    } else {
      merged.push(te);
      tvAdded++;
    }
  }

  // B2. Masukkan rilis TradingView 60 hari ke BELAKANG yang belum ada di kalender.
  // Sebelumnya hanya Actual untuk baris yang sudah ada yang diisi dari TradingView,
  // sehingga NFP 6 Nov 2026, Jobless Claims, CPI/PCE & FOMC lampau ikut HILANG saat
  // jendela kalender tertarik ke depan. Importance/waktu/judul dari TradingView
  // sudah terfilter sama seperti B.
  let tvPastAdded = 0;
  try {
    const pastFrom = now - pastHoldMs;
    const pastRows = await fetchTradingViewCalendar(pastFrom, now + 5 * 60 * 1000);
    for (const te of parseTradingViewEvents(pastRows)) {
      const t = Date.parse(te.Date);
      if (!Number.isFinite(t) || t > now) continue;
      const idx = merged.findIndex(m => areEventsMatching(te, m));
      if (idx >= 0) {
        const ev = merged[idx];
        if (!ev.Forecast && te.Forecast) ev.Forecast = te.Forecast;
        if (!ev.Previous && te.Previous) ev.Previous = te.Previous;
        if (!ev.Actual && te.Actual) ev.Actual = te.Actual;
        continue;
      }
      merged.push(te);
      tvPastAdded++;
    }
  } catch (err) {
    console.error('TradingView kalender lampau dilewati:', err && err.message || err);
  }

  if (!merged.length) {
    console.error('Semua sumber kalender kosong; calendar.json lama dipertahankan.');
    return existing;
  }

  // Gabungkan baris kembar FF/TV sebelum Actual di-backfill.
  merged = dedupeCalendarEvents(merged);

  // Urutkan berdasarkan tanggal rilis
  merged.sort((a, b) => new Date(a.Date) - new Date(b.Date));

  // D. Isi Actual yang belum terisi untuk event masa lalu
  const finalized = await backfillActuals(merged, now);

  const payload = JSON.stringify(finalized, null, 2);
  const previous = await fs.readFile('data/calendar.json', 'utf8').catch(() => '');
  if (payload !== previous) {
    await fs.writeFile('data/calendar.json', payload);
  }
  console.log(`Berhasil menyimpan calendar.json dengan ${finalized.length} berita (${tvAdded} berita baru TradingView ke depan, ${tvPastAdded} event TradingView lampau yang dikembalikan).`);
  return finalized;
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
      url: 'https://api.binance.com/api/v3/ticker/24hr?symbols=["BTCUSDT","ETHUSDT"]',
      parse(j, sourceName) {
        if (!Array.isArray(j)) return null;
        const btc = j.find(x => x.symbol === 'BTCUSDT');
        const eth = j.find(x => x.symbol === 'ETHUSDT');
        return valid(
          { 'BTC/USD': Number(btc && btc.lastPrice), 'ETH/USD': Number(eth && eth.lastPrice) },
          sourceName,
          { 'BTC/USD': finiteNumber(btc && btc.priceChangePercent), 'ETH/USD': finiteNumber(eth && eth.priceChangePercent) }
        );
      }
    },
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
      url: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true',
      parse(j, sourceName) {
        return valid(
          { 'BTC/USD': Number(j && j.bitcoin && j.bitcoin.usd), 'ETH/USD': Number(j && j.ethereum && j.ethereum.usd) },
          sourceName,
          { 'BTC/USD': finiteNumber(j && j.bitcoin && j.bitcoin.usd_24h_change), 'ETH/USD': finiteNumber(j && j.ethereum && j.ethereum.usd_24h_change) }
        );
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

  function valid(out, sourceName, chg = {}) {
    const rates = {
      'BTC/USD': Number(out && out['BTC/USD']),
      'ETH/USD': Number(out && out['ETH/USD'])
    };
    if (!(rates['BTC/USD'] > 0 && rates['ETH/USD'] > 0)) return null;
    const changePct = {};
    if (finiteNumber(chg['BTC/USD']) !== null) changePct['BTC/USD'] = Number(chg['BTC/USD'].toFixed(2));
    if (finiteNumber(chg['ETH/USD']) !== null) changePct['ETH/USD'] = Number(chg['ETH/USD'].toFixed(2));
    return { rates, changePct, source: sourceName };
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
  { pair: 'US500', yahoo: '^GSPC', reactionFrom: 'ES=F' }
];
const MARKETS_FILE = 'data/markets.json';
const CRYPTO_FILE = 'data/crypto.json';
const HISTORY_BARS_FILE = 'data/history-bars.json';
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
  return { meta, bars: bars.slice(-MARKET_BARS), allBars: bars };
}

export function aggregateBars(bars, bucketMin = 5) {
  if (!Array.isArray(bars) || !bars.length || bucketMin <= 1) return Array.isArray(bars) ? bars : [];
  const out = [];
  for (const b of bars) {
    const k = Number(b && b.k), o = Number(b && b.o), h = Number(b && b.h), l = Number(b && b.l), c = Number(b && b.c);
    if (!Number.isFinite(k) || !(o > 0 && h > 0 && l > 0 && c > 0)) continue;
    const bk = Math.floor(k / bucketMin) * bucketMin;
    const prev = out[out.length - 1];
    if (prev && prev.k === bk) {
      if (h > prev.h) prev.h = h;
      if (l < prev.l) prev.l = l;
      prev.c = c;
    } else {
      out.push({ k: bk, o, h, l, c });
    }
  }
  return out;
}

export function buildMarketPayload({ price, forex, crypto, yahooByPair, now = new Date() }) {
  const quotes = { ...(forex || {}) };
  if (finiteNumber(price) && price > 0) quotes['XAU/USD'] = { price, source: 'gold-api', changePct: null };
  if (crypto && crypto.rates) {
    for (const [pair, value] of Object.entries(crypto.rates)) {
      if (finiteNumber(value) && value > 0) {
        const chg = crypto.changePct ? finiteNumber(crypto.changePct[pair]) : null;
        quotes[pair] = { price: value, source: crypto.source, changePct: chg };
      }
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
      pairs: cryptoData.rates,
      changePct: cryptoData.changePct || {}
    }, null, 2));
  }
  const histPairs = {};
  for (const cfg of MARKET_SYMBOLS) {
    const raw = yahooByPair[cfg.pair] && yahooByPair[cfg.pair].allBars;
    const agg = aggregateBars(raw, 5);
    if (agg.length) histPairs[cfg.pair] = agg;
  }
  if (Object.keys(histPairs).length) {
    await fs.writeFile(HISTORY_BARS_FILE, JSON.stringify({
      generatedAt: payload.generatedAt,
      intervalMin: 5,
      source: 'Yahoo Finance 5m resampled from 5d 1m OHLC',
      pairs: histPairs
    }));
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
  maxBaseAgeMin = 30,
  spikeMin = 5
} = {}) {
  const release = Number(releaseMs);
  if (!Number.isFinite(release)) return null;
  const rows = (bars || [])
    .map(bar => ({ t: Number(bar && bar.k) * 60000, c: Number(bar && bar.c) }))
    .filter(row => Number.isFinite(row.t) && Number.isFinite(row.c) && row.c > 0)
    .sort((a, b) => a.t - b.t);
  if (!rows.length) return null;

  // Bar ber-key menit MULAI (k*60000). Bar yang mulai tepat di menit rilis sudah memuat
  // spike, jadi basis = close bar yang SELESAI (t + 60s) sebelum/pada waktu rilis.
  let base = null;
  for (const row of rows) {
    if (row.t + 60000 <= release) base = row;
    else break;
  }
  if (!base || release - (base.t + 60000) > maxBaseAgeMin * 60000) return null;

  let last = null;
  for (const row of rows) {
    if (row.t >= release + settleMin * 60000 && row.t <= release + horizonMin * 60000) last = row;
  }
  if (!last || last.t <= base.t) return null;

  const movePct = Number(((last.c - base.c) / base.c * 100).toFixed(3));
  const dir = Math.abs(movePct) < minMovePct ? null : (movePct > 0 ? 'long' : 'short');
  // Spike awal (<= spikeMin menit) vs arah akhir: spike yang berbalik = fade/fakeout.
  let spike = null;
  for (const row of rows) {
    if (row.t >= release && row.t <= release + spikeMin * 60000) spike = row;
  }
  const spikePct = spike ? Number(((spike.c - base.c) / base.c * 100).toFixed(3)) : null;
  const faded = Boolean(dir && spikePct !== null && Math.abs(spikePct) >= minMovePct * 2 && Math.sign(spikePct) !== Math.sign(movePct));
  return {
    baseClose: base.c,
    lastClose: last.c,
    movePct,
    dir,
    minutes: Math.round((last.t - release) / 60000),
    spikePct,
    faded
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
      // Bar milik sendiri diprioritaskan; sumber cadangan (mis. ES=F untuk US500)
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

// ═══ PENGGERAK EMAS HARIAN — EMPAT FAKTOR DOMINAN ═══════════════════════════
// 1. Real yield AS & Treasury 10Y : biaya peluang memegang emas tanpa kupon.
// 2. DXY / USD                    : harga emas dinyatakan dalam dolar.
// 3. Kebijakan Fed & inflasi       : arah suku bunga riil (CPI/PCE surprise).
// 4. Pembelian bank sentral & aliran ETF emas : basis permintaan fisik.
//
// Semua dibaca dari feed publik tanpa API key. Bila satu feed gagal, field-nya
// null dan kartu di halaman menampilkan "—" — tidak ada nilai karangan.
const SENTIMENT_FILE = 'data/sentiment.json';
const YAHOO_HEADERS = { 'user-agent': 'Mozilla/5.0' };
const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

async function readJsonSafe(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) || null; } catch { return null; }
}

function firstNumber(value) {
  if (value == null) return null;
  const m = String(value).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** Seri harian Yahoo (close + volume) untuk satu simbol. */
export async function fetchYahooDaily(symbol, { range = '1mo', fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
  const r = await fetchImpl(url, { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const chart = j && j.chart && j.chart.result && j.chart.result[0];
  if (!chart) throw new Error('chart kosong');
  const ts = Array.isArray(chart.timestamp) ? chart.timestamp : [];
  const q = chart.indicators && chart.indicators.quote && chart.indicators.quote[0];
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    const close = finiteNumber(q && q.close && q.close[i]);
    if (close == null || !(close > 0)) continue;
    rows.push({
      date: new Date(Number(ts[i]) * 1000).toISOString().slice(0, 10),
      close,
      volume: finiteNumber(q && q.volume && q.volume[i]) || 0
    });
  }
  if (!rows.length) throw new Error('seri kosong');
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)); // pastikan urutan menaik (terlama → terbaru)
  const last = rows[rows.length - 1];
  const closeAt = back => (rows.length > back ? rows[rows.length - 1 - back].close : null);
  const pct = (a, b) => (a != null && b != null && b > 0 ? Number((((a - b) / b) * 100).toFixed(4)) : null);
  const volWindow = rows.slice(-21, -1).map(x => x.volume).filter(v => v > 0);
  const avgVol = volWindow.length ? volWindow.reduce((s, v) => s + v, 0) / volWindow.length : null;
  return {
    symbol,
    date: last.date,
    closes: rows.map(x => x.close),
    last: last.close,
    change1d: pct(last.close, closeAt(1)),
    change5d: pct(last.close, closeAt(5)),
    // perubahan absolut (poin persen) — dipakai untuk yield/suku bunga
    absChange1d: Number.isFinite(closeAt(1)) ? Number((last.close - closeAt(1)).toFixed(4)) : null,
    volume: last.volume,
    volumeRatio: avgVol && last.volume > 0 ? Number((last.volume / avgVol).toFixed(3)) : null
  };
}

/** z-score nilai terakhir terhadap `window` titik terakhir.
 *  Relatif terhadap seri data sendiri — bukan ambang opini. */
export function zScore(series, window = 20) {
  const s = (Array.isArray(series) ? series : []).filter(v => Number.isFinite(v)).slice(-window);
  if (s.length < 5) return null;
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length);
  if (!(sd > 0)) return 0;
  return Number(((s[s.length - 1] - mean) / sd).toFixed(3));
}

/** CSV kurva yield riil harian US Treasury (baris terbaru di atas). */
export function parseTreasuryYieldCsv(csv) {
  const lines = String(csv || '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return null;
  const head = lines[0].split(',').map(c => c.replace(/^"|"$/g, '').trim());
  const col = head.findIndex(h => /^10\s*YR$/i.test(h));
  if (col < 0) return null;
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    const m = (cells[0] || '').match(/^\s*"?(\d{2})\/(\d{2})\/(\d{4})/);
    const value = finiteNumber((cells[col] || '').replace(/"/g, '').trim());
    if (!m || value == null) continue;
    rows.push({ date: `${m[3]}-${m[1]}-${m[2]}`, value });
  }
  if (!rows.length) return null;
  const latest = rows[0];
  const prev = rows[1] || null;
  return {
    value: latest.value,
    date: latest.date,
    change1d: prev ? Number((latest.value - prev.value).toFixed(3)) : null,
    // urut naik (tertua -> terbaru) agar zScore membaca tren dengan benar
    series: rows.map(r => r.value).reverse().slice(-60)
  };
}

export async function fetchTreasuryRealYield({ fetchImpl = fetch, now = Date.now(), timeoutMs = 15000 } = {}) {
  const year = new Date(now).getUTCFullYear();
  const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_real_yield_curve&field_tdr_date_value=${year}&page&_format=csv`;
  const r = await fetchImpl(url, { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return parseTreasuryYieldCsv(await r.text());
}

/** Kejutan inflasi terbaru (Actual - Forecast) dari kalender rilis.
 *  surprise > 0 = data di atas perkiraan = tekanan hawkish. */
export function inflationFromEvents(events, now = Date.now()) {
  const out = { cpi: null, pce: null, latest: null };
  for (const raw of Array.isArray(events) ? events : []) {
    const title = String((raw && (raw.Event || raw.event)) || '');
    // Hanya rilis AS: kebijakan Fed hanya dipengaruhi CPI/PCE Amerika.
    const country = String((raw && (raw.Country || raw.country)) || '').trim();
    if (country && !/united states|^usa$|^usd$/i.test(country)) continue;
    const key = /\bpce\b/i.test(title) ? 'pce'
      : /\bcpi\b|\binflation rate\b/i.test(title) ? 'cpi' : null;
    if (!key) continue;
    if (Number(raw && (raw.Importance || raw.importance)) < 2) continue;
    const t = Date.parse(raw && (raw.Date || raw.date));
    if (!Number.isFinite(t) || t > now) continue;
    const actual = firstNumber(raw && (raw.Actual || raw.actual));
    const forecast = firstNumber(raw && (raw.Forecast || raw.forecast));
    if (actual == null || forecast == null) continue;
    const rec = {
      event: title,
      date: new Date(t).toISOString(),
      actual, forecast,
      surprise: Number((actual - forecast).toFixed(4))
    };
    if (!out[key] || t > Date.parse(out[key].date)) out[key] = rec;
  }
  out.latest = [out.cpi, out.pce].filter(Boolean)
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0] || null;
  return out;
}

/** Unit beredar IAU (iShares Gold Trust) dari halaman resmi iShares.
 *  Delta antar-hari = net creation/redemption = aliran ETF emas riil. */
export async function fetchIauSharesOutstanding({ fetchImpl = fetch, timeoutMs = 25000 } = {}) {
  const url = 'https://www.ishares.com/us/products/239726/ishares-gold-trust';
  const r = await fetchImpl(url, { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = (await r.text()).replace(/&quot;/g, '"');
  const m = html.match(/"label"\s*:\s*"Shares Outstanding"\s*,\s*"formattedValue"\s*:\s*"([0-9,]+)"[\s\S]{0,240}?"formattedAsOfDate"\s*:\s*"([^"]+)"/);
  if (!m) return null;
  const shares = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(shares) || !(shares > 0)) return null;
  return { shares, asOf: m[2], source: 'iShares Gold Trust (IAU)' };
}

/** Faktor 4: aliran ETF emas + (bila tersedia) permintaan resmi/bank sentral. */
async function fetchGoldFlows({ fetchImpl, prev, now }) {
  const [gld, iau, spot, sharesOut] = await Promise.all([
    fetchYahooDaily('GLD', { fetchImpl }).catch(() => null),
    fetchYahooDaily('IAU', { fetchImpl }).catch(() => null),
    fetchYahooDaily('GC=F', { fetchImpl }).catch(() => null),
    fetchIauSharesOutstanding({ fetchImpl }).catch(() => null)
  ]);
  if (!gld && !iau && !spot && !sharesOut) return null;

  const avg = vals => {
    const v = vals.filter(x => Number.isFinite(x));
    return v.length ? Number((v.reduce((a, b) => a + b, 0) / v.length).toFixed(4)) : null;
  };
  const etfChange1d = avg([gld && gld.change1d, iau && iau.change1d]);
  const etfChange5d = avg([gld && gld.change5d, iau && iau.change5d]);
  const spotChange5d = spot && Number.isFinite(spot.change5d) ? spot.change5d : null;
  const basis5d = etfChange5d != null && spotChange5d != null
    ? Number((etfChange5d - spotChange5d).toFixed(4)) : null;
  const volumeRatio = avg([gld && gld.volumeRatio, iau && iau.volumeRatio]);

  // Delta unit beredar: hanya bila tanggal as-of benar-benar berganti,
  // supaya run 15-menit yang sama tidak melaporkan aliran palsu.
  const prevShares = prev && prev.flows && prev.flows.shares;
  let sharesChange = null, flowPct = null, flowScore = null;
  if (sharesOut && prevShares && prevShares.asOf !== sharesOut.asOf
      && Number.isFinite(prevShares.shares) && prevShares.shares > 0) {
    sharesChange = sharesOut.shares - prevShares.shares;
    flowPct = Number(((sharesChange / prevShares.shares) * 100).toFixed(4));
    flowScore = clampNum(flowPct * 150, -100, 100);
  }

  return {
    etfChange1d, etfChange5d, spotChange5d, basis5d, volumeRatio,
    sharesOutstanding: sharesOut ? sharesOut.shares : null,
    sharesAsOf: sharesOut ? sharesOut.asOf : null,
    sharesChange, flowPct, flowScore,
    // Feed cadangan bank sentral tidak punya endpoint publik tanpa API key;
    // bila tidak tersedia, kartu memakai komponen ETF dan menyatakan hal itu.
    centralBank: (prev && prev.flows && prev.flows.centralBank) || null,
    source: 'Yahoo GLD/IAU/GC=F · iShares IAU'
  };
}

async function fetchGoldDrivers({ fetchImpl = fetch, events = null, prev = null, now = Date.now() } = {}) {
  const [real, nom, dxy, fed, bill] = await Promise.all([
    fetchTreasuryRealYield({ fetchImpl, now }).catch(() => null),
    fetchYahooDaily('^TNX', { fetchImpl }).catch(() => null),
    fetchYahooDaily('DX-Y.NYB', { fetchImpl }).catch(() => null),
    fetchYahooDaily('ZQ=F', { fetchImpl }).catch(() => null),
    fetchYahooDaily('^IRX', { fetchImpl }).catch(() => null)
  ]);
  const [inflation, flows] = await Promise.all([
    Promise.resolve(inflationFromEvents(events, now)),
    fetchGoldFlows({ fetchImpl, prev, now })
  ]);

  const yieldDriver = real || nom ? {
    tenYr: nom ? nom.last : null,
    tenYrChange1d: nom && Number.isFinite(nom.change1d) ? nom.change1d : null,
    zNominal: nom ? zScore(nom.closes) : null,
    realTenYr: real ? real.value : null,
    realChange1d: real ? real.change1d : null,
    zReal: real ? zScore(real.series) : null,
    date: real ? real.date : (nom ? nom.date : null),
    source: 'US Treasury (yield riil) · Yahoo ^TNX (nominal)'
  } : null;

  const dxyDriver = dxy ? {
    price: dxy.last,
    change1d: dxy.change1d,
    change5d: dxy.change5d,
    z: zScore(dxy.closes),
    date: dxy.date,
    source: 'Yahoo DX-Y.NYB'
  } : null;

  const fedDriver = fed || bill || inflation.latest ? {
    impliedRate: fed ? Number((100 - fed.last).toFixed(3)) : (bill ? bill.last : null),
    change1d: bill ? bill.absChange1d : null,
    z: bill ? zScore(bill.closes) : null,
    inflation,
    date: fed ? fed.date : (bill ? bill.date : (inflation.latest ? inflation.latest.date.slice(0, 10) : null)),
    source: 'Yahoo ZQ=F (Fed funds futures) · Yahoo ^IRX (T-bill) · kalender CPI/PCE'
  } : null;

  const drivers = {
    yield: yieldDriver,
    dxy: dxyDriver,
    fed: fedDriver,
    flows
  };
  if (!yieldDriver && !dxyDriver && !fedDriver && !flows) return null;
  return drivers;
}

// Bobot: keempat faktor memang dominan menggerakkan XAU/USD harian, jadi
// bobotnya dibuat berdekatan (yield sedikit lebih berat karena paling langsung).
const GOLD_DRIVER_WEIGHTS = { yield: 0.30, dxy: 0.25, fed: 0.25, flows: 0.20 };

/** Skor per faktor [-100..+100], + = mendukung emas naik. Murni dari data. */
export function scoreGoldDrivers(drivers) {
  const d = drivers || {};
  const parts = {};

  // 1) Yield naik (di atas rata-rata 20 hari) -> bearish emas.
  const yz = [d.yield && d.yield.zNominal, d.yield && d.yield.zReal].filter(v => Number.isFinite(v));
  parts.yield = yz.length ? Math.round(clampNum(-(yz.reduce((a, b) => a + b, 0) / yz.length) * 34, -100, 100)) : null;

  // 2) DXY menguat -> bearish emas.
  parts.dxy = d.dxy && Number.isFinite(d.dxy.z)
    ? Math.round(clampNum(-d.dxy.z * 34, -100, 100)) : null;

  // 3) Suku bunga implied naik / inflasi surprise positif -> hawkish -> bearish emas.
  const fedLegs = [];
  if (d.fed && Number.isFinite(d.fed.z)) fedLegs.push(clampNum(-d.fed.z * 34, -100, 100));
  const inf = d.fed && d.fed.inflation && Number.isFinite(d.fed.inflation.surprise)
    ? d.fed.inflation.surprise : null;
  if (inf != null) {
    const scale = Math.max(Math.abs((d.fed.inflation.forecast) || 0), 0.1);
    fedLegs.push(clampNum(-(inf / scale) * 45, -100, 100));
  }
  parts.fed = fedLegs.length ? Math.round(clampNum(fedLegs.reduce((a, b) => a + b, 0) / fedLegs.length, -100, 100)) : null;

  // 4) Net creation ETF (+), basis ETF vs spot (+), volume di atas rata-rata (+).
  const f = d.flows || {};
  const flowLegs = [];
  if (Number.isFinite(f.flowScore)) flowLegs.push(f.flowScore);
  if (Number.isFinite(f.basis5d)) flowLegs.push(clampNum(f.basis5d * 60, -100, 100));
  if (Number.isFinite(f.volumeRatio)) {
    // Volume hanya mengkonfirmasi ARAH: volume besar saat harga turun = tekanan jual.
    const dir = Number.isFinite(f.etfChange1d) ? Math.sign(f.etfChange1d)
      : (Number.isFinite(f.basis5d) ? Math.sign(f.basis5d) : 0);
    flowLegs.push(clampNum(dir * (f.volumeRatio - 1) * 50, -100, 100));
  }
  parts.flows = flowLegs.length ? Math.round(clampNum(flowLegs.reduce((a, b) => a + b, 0) / flowLegs.length, -100, 100)) : null;

  const present = Object.keys(GOLD_DRIVER_WEIGHTS).filter(k => parts[k] != null);
  const totalW = present.reduce((s, k) => s + GOLD_DRIVER_WEIGHTS[k], 0);
  const score = totalW > 0
    ? Math.round(present.reduce((s, k) => s + parts[k] * GOLD_DRIVER_WEIGHTS[k], 0) / totalW)
    : null;

  return {
    score,
    label: goldDriverLabel(score),
    parts,
    weights: GOLD_DRIVER_WEIGHTS,
    missing: Object.keys(GOLD_DRIVER_WEIGHTS).filter(k => parts[k] == null)
  };
}

export function goldDriverLabel(score) {
  if (!Number.isFinite(score)) return 'Belum ada data';
  if (score >= 45) return 'Bullish Kuat';
  if (score >= 15) return 'Bullish';
  if (score > -15) return 'Netral';
  if (score > -45) return 'Bearish';
  return 'Bearish Kuat';
}

export async function fetchSentiment({ fetchImpl = fetch, events = null, now = Date.now(), write = true } = {}) {
  const prev = await readJsonSafe(SENTIMENT_FILE);
  const out = {
    generatedAt: new Date(now).toISOString(),
    cnn: null, crypto: null,
    drivers: null, goldDrivers: null
  };
  const [cnn, crypto, drivers] = await Promise.all([
    (async () => {
      try {
        const r = await fetchImpl('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
          headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://edition.cnn.com/' },
          signal: AbortSignal.timeout(10000)
        });
        if (!r.ok) return;
        const j = await r.json();
        const fg = j && j.fear_and_greed;
        const score = fg ? Number(fg.score) : NaN;
        if (Number.isFinite(score)) {
          return {
            score: Math.round(score),
            rating: fg.rating || '',
            previousClose: finiteNumber(fg.previous_close)
          };
        }
      } catch {}
    })(),
    (async () => {
      try {
        const r = await fetchImpl('https://api.alternative.me/fng/?limit=1', {
          headers: { 'user-agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(10000)
        });
        if (!r.ok) return;
        const j = await r.json();
        const d = j && j.data && j.data[0];
        const score = d ? Number(d.value) : NaN;
        if (Number.isFinite(score)) {
          return {
            score: Math.round(score),
            rating: d.value_classification || ''
          };
        }
      } catch {}
    })(),
    fetchGoldDrivers({ fetchImpl, events, prev, now }).catch(() => null)
  ]);
  out.cnn = cnn || null;
  out.crypto = crypto || null;
  out.drivers = drivers || null;
  out.goldDrivers = drivers ? scoreGoldDrivers(drivers) : null;

  if (write && (out.cnn || out.crypto || out.drivers)) {
    await fs.writeFile(SENTIMENT_FILE, JSON.stringify(out, null, 2));
    console.log('Sentimen Fear & Greed tersimpan:',
      out.cnn ? `CNN=${out.cnn.score}` : 'CNN=-',
      out.crypto ? `Crypto=${out.crypto.score}` : 'Crypto=-',
      out.goldDrivers ? `Penggerak Emas=${out.goldDrivers.score} (${out.goldDrivers.label})` : 'Penggerak Emas=-');
  }
  return out;
}

export async function main() {
  const events = await fetchCalendar();
  // fetchSentiment menerima `events` agar faktor inflasi (CPI/PCE) dibaca dari
  // kalender rilis yang sama — satu sumber, tanpa feed tambahan.
  const [price, forexData, cryptoData, indices] = await Promise.all([fetchMarket(), fetchForex(), fetchCrypto(), fetchIndices(), fetchSentiment({ events })]);
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
