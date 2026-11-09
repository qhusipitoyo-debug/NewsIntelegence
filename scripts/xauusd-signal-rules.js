export function getGoldSignal({ event = '', actual, forecast, importance = 1 }) {
  const name = String(event).toLowerCase();
  const isMissing = value => value === null || value === undefined || String(value).trim() === '';
  if (isMissing(actual) || isMissing(forecast)) {
    return { dir: 'wait', score: Math.max(35, 48 - Number(importance || 1) * 2), reason: 'Actual dan Forecast keduanya harus tersedia untuk menghasilkan sinyal directional.' };
  }
  const a = Number(actual);
  const f = Number(forecast);
  if (!Number.isFinite(a) || !Number.isFinite(f)) {
    return { dir: 'wait', score: Math.max(35, 48 - Number(importance || 1) * 2), reason: 'Actual dan Forecast keduanya harus berupa nilai numerik yang valid.' };
  }
  const surprise = a - f;
  const absF = Math.abs(f);
  const threshold = (/payroll|nonfarm|nfp|claims|jobless|jolts|adp/i.test(name) || absF >= 1000)
    ? Math.max(absF * 0.02, 5000)
    : (/pmi|ism|sentiment|confidence|michigan/i.test(name) || (absF >= 20 && absF <= 150))
      ? 0.3
      : Math.max(absF * 0.005, 0.01);
  if (Math.abs(surprise) < threshold) {
    return { dir: 'wait', score: 45, reason: `Actual ${a} vs Forecast ${f}: deviasi ekonomi terlalu kecil / dalam batas toleransi pasar (flat).` };
  }
  const inflationHigherBearish = /cpi|inflation|pce|pmi|ism|retail sales|consumer confidence|consumer sentiment|fed funds|interest rate|rate decision|jolts|durable goods|ppi|producer price|sentiment|michigan|trade balance|current account|industrial production|factory orders|conference board|consumer optimism|ifo index|economic optimism/.test(name);
  const nfpHigherBearish = /nonfarm payroll|non-farm payroll|nfp|payroll|average hourly earnings|hourly earnings|wages/.test(name);
  const unemploymentHigherBullish = /unemployment rate|unemployment/.test(name);
  const claimsHigherBullish = /initial claims|continuing claims|jobless claims/.test(name);
  let goldBullish;
  if (unemploymentHigherBullish || claimsHigherBullish) goldBullish = surprise > 0;
  else if (inflationHigherBearish || nfpHigherBearish) goldBullish = surprise < 0;
  else return { dir: 'wait', score: 40, reason: `Belum tersedia pemetaan dampak ekonomi XAUUSD untuk ${name}.` };
  const strength = Math.min(40, Math.round(Math.abs(surprise) / threshold * 10));
  const score = Math.min(95, Math.max(55, 55 + strength));
  return { dir: goldBullish ? 'long' : 'short', score, reason: `Actual ${a} vs Forecast ${f}. ${goldBullish ? 'Data USD lebih lemah dari ekspektasi -> Bias bullish untuk Emas (BUY).' : 'Data USD lebih kuat dari ekspektasi -> Bias bearish untuk Emas (SELL).'}` };
}

// Overlay sentimen pasar eksternal (CNN Fear & Greed Index + AAII survey).
// score: CNN F&G 0..100 (75+ = extreme greed -> risk-off, <25 = extreme fear -> risk-on)
// aai: AAII net % (bullish minus bearish). Mengembalikan { dir, score, aai } atau null.
export function sentimentOverlay(score, aai) {
  const s = Number(score);
  const hasScore = score !== null && score !== undefined && String(score).trim() !== '' && Number.isFinite(s);
  if (!hasScore) return null;
  const aa = Number(aai);
  const aaDir = Number.isFinite(aa) ? (aa < -10 ? 'long' : aa > 10 ? 'short' : null) : null;
  const dir = aaDir || (s <= 25 ? 'long' : s >= 75 ? 'short' : null);
  if (dir === null) return null;
  return { dir, score: s, aai: Number.isFinite(aa) ? aa : null };
}
