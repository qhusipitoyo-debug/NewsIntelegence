# Feriha Intelligence

<p align="center">
  <a href="[https://MarketForgeX.github.io/xauusd-ai-terminal]" target="_blank" rel="noopener noreferrer"><strong>🚀 CHECK LIVE TERMINAL</strong></a>
</p>

## Publish

1. Copy these files to the repository root and push.
2. Regenerate the exposed Twelve Data key, then add the new key in GitHub Actions secrets as `TWELVE_DATA_API_KEY`.
3. Run the `Update live economic calendar` workflow once.
4. Enable GitHub Pages from `main` and `/ (root)`.

The calendar uses Forex Factory's free public weekly export for the event list and TradingView's free economic calendar only to backfill released `Actual` values; no calendar key is required. The workflow merges each refresh into the current month and updates XAU/USD, live forex quotes and index snapshots every 15 minutes. All displayed times use Waktu Indonesia Tengah (`Asia/Makassar`, UTC+8). Never put the private API key in public HTML. LONG/SHORT is scenario analysis, not a prediction.

## Forex majors, JPY crosses & indices pre-news BUY/SELL

The terminal has an always-visible **Forex Majors & JPY Crosses** board for EUR/USD, GBP/USD, USD/JPY, USD/CHF, AUD/USD, USD/CAD, NZD/USD, GBP/JPY and EUR/JPY under the gold/crypto boards. Before each medium/high-impact release it shows an explicit **BUY · MARKET** or **SELL · MARKET** entry with Entry/SL/TP (adaptive 25–30 pips base, widened by impact and measured reaction, 1:2 RR). The direction comes from the event's Forecast vs Previous using the same economic mapping as the gold bias:

- Higher US inflation/payrolls → USD stronger → SELL EUR/USD, GBP/USD, AUD/USD; BUY USD/JPY, USD/CHF, USD/CAD.
- Higher non-US inflation/employment → that currency stronger → BUY its XXX/USD pair; SELL its USD/XXX pair.
- Higher US jobless claims/unemployment → USD weaker → BUY XXX/USD; SELL USD/XXX.
- For crosses, the event currency decides the leg: GBP/JPY follows GBP news directly and JPY news inversely; EUR/JPY follows EUR directly and JPY inversely. A USD event is treated as risk-on/off.
- If Forecast equals Previous, the board borrows the nearest same-currency medium/high event within 6 hours; otherwise it shows **WAIT** with straddle levels.

### Arah pasca-rilis (post-news)

Forex Factory's free exports contain **no `actual` field at all** (verified in both the JSON and XML feeds), so a released event used to freeze on `WAIT 46% confidence` forever. Two steps fix that:

- **Actual backfill.** `scripts/fetch-calendar.mjs` also reads the public TradingView economic calendar (`https://economic-calendar.tradingview.com/events`, no API key, but it returns HTTP 403 unless `user-agent` + `origin` + `referer` are sent, and `country=` is ignored so rows are filtered by `currency`). Forex Factory remains the primary list: only an empty `Actual` is ever written, importance/times/titles stay from Forex Factory, and TradingView's own importance is ignored. Matching is minute-rounded with a 5-minute tolerance plus head-noun title agreement, so "Spanish Services PMI" lines up with "S&P Global Services PMI" but a Belgian print can never be written onto a Euro-area row. Scale is only applied when the shared reference value proves a 10^n factor (e.g. Austrian "Unemployed persons" 314.5 vs 306600), percent suffixes from Forex Factory are re-applied, and anything ambiguous or unscaled is refused instead of guessed. `calendar.json` is rewritten only when at least one value was filled, and any TradingView failure falls back silently to the old calendar so the 15-minute cron never breaks.
- **Price reaction.** Some series (all S&P Global PMIs) simply have no published actual anywhere. For those, direction is measured from the 270 Yahoo 1-minute bars already stored in `data/markets.json`: the last close at or before the release versus the last close 15–45 minutes after it, written to `data/reaction.json` for releases in the last 6 hours and held for at most 45 minutes in the browser. `NAS100`/`US500` cannot be measured from their own bars — Yahoo only publishes `^NDX`/`^GSPC` 1-minute history inside the regular session (13:30–21:00 UTC), so `MARKET_SYMBOLS` carries `reactionFrom: 'NQ=F'`/`'ES=F'` and `fetchReactionBars()` pulls the ~23h futures series as a backup. An asset's own bars still win; the backup is only used when they do not cover the release, and the result is labelled `via: 'NQ=F'` so the card can state where the bar came from. `data/markets.json` keeps its old shape — `pairs['NAS100'].yahoo` is still `^NDX`.

Direction is then resolved with price first, and the label always names the basis actually used:

`reaksi harga 1 menit pasca-rilis` → `momentum pra-rilis → sekarang (maks 90 menit)` → `Actual vs Forecast` → `Actual vs Previous` → **`NO ACTUAL DATA`**.

The first 15 minutes after a release are **not tradable**: `newsPhase()` returns `live`, every board hides Entry/SL/TP, and the card says to wait for confirmation. This avoids entering the first spike while the spread is still wide. After that, price reaction wins over the economic surprise. If `Actual` conflicts with the confirmed price direction, the signal follows the price and the note says so (`berlawanan dengan Actual, sinyal mengikuti harga`) instead of fighting the market.

Every confirmed `Entry/SL/TP` is locked in `localStorage` under `feriha:signal:v2:<Date|Event>|<ASSET>` and reused until the 6-hour post-news window expires. A locked order never repaints tick-by-tick and the direction never flips to chase price; a reversal is shown as `⚠️ Arah berbalik — batalkan order lama`. A price that has already run past the entry is marked `⚠️ Entry terlewat — tunggu pullback`. SL/TP are volatility/impact adaptive with a fixed 1:2 R:R: forex uses 25–30 pips base (30 for JPY) widened by impact and measured reaction, gold/crypto/indices use 0.55–1.5% base widened the same way. Exact broker bid/ask is used for forex entries when the MT5 quote is fresh.

A released event inside the 6-hour window keeps its slot on the pair board (badge `BUY/SELL · POST-NEWS` with `valid s/d <expiry>`), an unresolved one is shown as `NO ACTUAL DATA` instead of a synthetic percentage — the confidence meter prints `—` whenever there is no computed surprise. Own-event edge (Forecast vs Previous, or a real Actual) is allowed for **every** impact level including Forex Factory "Low"; only the neighbour-borrowing fallback in `preNewsBias()` and the gold/USD boards stay at importance 2+. Reaction and momentum directions are asset-relative (the pair's own price rose) and are therefore never re-mapped through `mapPairBias()`.

The **Nasdaq 100 & S&P 500** board (`NAS100`, `US500`) follows the same USD catalyst: BUY means risk-on/stronger index, SELL means risk-off/weaker index. Risk template is NAS100 1%/2% and US500 0.75%/1.5%. Prices come from Yahoo Finance via `data/indices.json` (refreshed by GitHub Actions), with a live CORS-proxy fallback in the browser.

### Entry order di board Gold, Crypto & Index

All three boards resolve direction through the same ladder as the pair board, and all three print `Entry/SL/TP` rather than only a straddle:

- **Gold** (`goldBoardState`) now reads the pre-release bias too. When `preNewsBias()` finds a Forecast-vs-Previous edge it emits `BUY · MARKET` / `SELL · MARKET` with volatility-adaptive levels, and the two straddle stops stay listed underneath with `Straddle OCO tetap tersedia bila arah tidak diambil.` Without an edge the card is exactly the old straddle-only view. After the release the 1-minute reaction is attempted whenever `analyze()` returns no direction — not only when the Actual is missing — so a flat print (`Actual sesuai perkiraan`) can still be traded off the bar move.
- **Crypto** (`cryptoBoardState`) had no direction logic at all before: `cryptoBoardHtml()` only printed the price, the 24h change and the risk template. It now shares `nextUsdCatalyst()` with the index board and runs the same ladder per asset (`reactionFor(e, 'BTC/USD')`, `momentumFor(e, 'crypto', pair)`), with `CRYPTO_PAIRS` as the single source for the base risk. `renderCryptoBoard()` is part of `render()`, so the board repaints when the calendar or `data/reaction.json` changes instead of only when Binance answers.
- **Index** cards no longer print a fake `+0.00%` inside the badge — `momPct` is initialised to `null`, and `Number(null) === 0` used to pass the finiteness check. Indices use event-aware mapping: growth/employment surprises (NFP, PMI, GDP, retail sales, jobless claims) are read as risk-on/risk-off and inverted relative to the gold/USD bias, while inflation events (CPI/PCE) keep the USD/rate pressure direction. A reaction measured from the futures backup is labelled, e.g. `Reaksi harga +0.24% dalam 40 mnt pasca-rilis — Actual tidak dipublikasikan (bar NQ=F)`.

Gold and crypto bias directions come from `analyze()`/`preNewsBias()` (USD language) and are mapped with `mapPairBias()`; index bias is mapped with `mapAssetBias()`/`mapActualBias()` (event-aware); reaction and momentum directions are asset-relative and are used as-is. `data/reaction.json` shape: `{ generatedAt, events: { "<Date>|<Event>": { releasedAt, pairs: { "<asset>": { baseClose, lastClose, movePct, dir, minutes, via? } } } } }`.

### Sumber harga forex

`data/forex.json` is generated by `scripts/fetch-calendar.mjs` every 15 minutes through the public TradingView scanner:

- **Anchor:** `OANDA` live quotes for all nine pairs (not the old daily `open.er-api.com` rate). The board reads the direct pair price, so GBP/JPY and EUR/JPY no longer need to be reconstructed from two daily USD rates.
- **Cross-check:** Saxo, FOREX.com, Capital.com, Pepperstone, Vantage, FP Markets, Eightcap, BlackBull Markets, ThinkMarkets and Skilling. `crossCheckPct` is the maximum deviation from the OANDA anchor; it is normally below 0.05%.
- **GO Markets, FBS, CMC Markets:** their public websites do not expose a CORS-free quote endpoint, and their TradingView feeds are not available to anonymous scanners. The workflow still probes `GOMARKETS`, `CMCMARKETS` and `FBS`, records `ok`/`unavailable` in `providers`, and the UI labels the OANDA mid as a reference price, not a broker fill. Exact broker bid/ask comes from the local MT5 bridge below when that broker terminal is logged in.
- **Fallback:** if every live feed fails, the fetcher writes the daily er-api rate and labels it `er-api (daily fallback)` in the UI. This fallback is deliberately visible, not silent.

`data/forex.json` shape: `{ generatedAt, source, anchor, quotes: { "EUR/USD": { price, consensus, source, changePct, crossCheckPct, providers } }, rates, providers }`. `rates` is USD-base and kept for the pre-news snapshot store; `quotes` is the direct pair price used by the board.

### Harga pair live di browser (tanpa API key)

A static file can only be as fresh as the 15-minute cron, so the pair board no longer depends on it. `loadForexLive()` in `index.html` POSTs directly to `https://scanner.tradingview.com/forex/scan` from the browser every 20 seconds and rebuilds the same payload shape the workflow writes (OANDA anchor, broker median, `crossCheckPct`, provider status), so the prices, `BUY/SELL · MARKET` entries and SL/TP levels move tick-by-tick instead of freezing between cron runs.

- Free and keyless: the scanner returns `access-control-allow-origin` for the Pages origin. The request must stay a CORS *simple* request, so the body is sent as `content-type: text/plain;charset=UTF-8`; `application/json` would trigger a preflight, and TradingView only allows `Referer, Accept` there. `user-agent`, `origin` and `referer` are forbidden headers in `fetch` and are not used.
- Gold, crypto and the countdown were already live (`api.gold-api.com` 30 s, Binance, 1 s clock). The pair board is now the same.
- The arrow next to each price (`▲ 0.8 pip`) is the delta against the previous pull; it only appears when the quote actually moved, so a quiet market shows no arrow rather than a fake one.
- Fallback chain: scanner → `data/forex.json` → daily `er-api`. Every failure grows the backoff by 5 minutes up to 20 minutes so a blocked network does not hammer the endpoint, and the source line states which mode the board is in: `LIVE — scanner TradingView ditarik ulang tiap 20 detik` or `SNAPSHOT 15 MENIT — scanner live sedang tidak terjangkau`.

`data/markets.json` is the consolidated market snapshot consumed by the matching **SniperFXBTCETHXAU** board. It contains XAU/USD, BTC/USD, ETH/USD, the seven Sniper FX majors, GBP/JPY, EUR/JPY and the NAS100/US500 indices, plus their latest Yahoo Finance 1-minute history. Consumers must read this file instead of calling Binance/Deriv/OANDA directly when they want prices to match this terminal.

`data/crypto.json` is written as well for convenience: `{ generatedAt, source, pairs: { "BTC/USD": number, "ETH/USD": number } }`.

`data/reaction.json` is the post-release price reaction derived from those 1-minute bars, keyed exactly like the pre-news store so the page can look it up with the same `Date|Event` key (shape documented in “Entry order di board Gold, Crypto & Index”).

### Local MT5 broker bid/ask

GitHub Actions cannot reach your PC, so the exact broker quote is exported by `scripts/mt5_quotes.py` on the Windows machine where MT5 is open and logged in. It reads `symbol_info_tick()` for the nine pairs and writes `data/forex-broker.json`; it never writes login numbers, balance, equity or credentials.

    python scripts\mt5_quotes.py       :: export only
    publish-broker-quotes.bat          :: export + commit + push
    install-broker-quotes-task.bat     :: schedule the publisher every 15 minutes

The scheduled task is `aiterminaltrading-broker-quotes`; it runs only while the user is logged on and MT5 is open. Log: `bridge\broker-quotes.log`.

`data/forex-broker.json` is intentionally minimal. It shape is `{ generatedAt, source, broker: { id, name, accountType }, quotes: { "EUR/USD": { bid, ask, mid, spread, spreadPips, digits, symbol, brokerTime } }, providers }`. The public file does **not** contain login, balance, equity, password, server name or terminal installation. `brokerTime` is the broker server clock; UI freshness uses `generatedAt`. When the file is at most 30 minutes old, the board shows the broker bid/ask and uses **ask for BUY** / **bid for SELL**. Older quotes are shown as STALE and the OANDA mid is used instead.

### Local scheduled market-data refresh

The scheduled GitHub Actions workflow is the normal updater, but it can be idle or delayed. To keep the Sniper bridge from serving stale data while this Windows PC is on, run the local publisher:

    install-market-data-task.bat

This creates the scheduled task `aiterminaltrading-market-data`, which runs `publish-market-data.bat` every 15 minutes:

1. `node scripts/fetch-calendar.mjs`
2. stage only the generated market/calendar files
3. skip commit when nothing changed
4. commit, pull/rebase, and push the fresh data

Log: `bridge\market-data.log`. The task runs only while the user is logged on and the PC has internet access. It does not use broker credentials and does not place orders.

### Ukuran repo & perapian riwayat mingguan

The 15-minute refresh commits rewrite `data/*.json` (largest: `data/markets.json`, ±680 KB) all day, so the repository grows by history, not by files: ±80 commit/hari → ±0,3 MB/hari. `.github/workflows/weekly-history-compaction.yml` merapikannya setiap **Minggu 20:00 UTC (Senin 03:00 WITA)**:

1. clone seluruh riwayat, simpan salinan `data/` versi terkini;
2. `git filter-repo --invert-paths --path data/` — blob data lama hilang dari riwayat, commit kode tetap utuh (commit yang jadi kosong ikut dipangkas);
3. `data/` versi terkini di-commit kembali, lalu **tree HEAD dibandingkan dengan tree sebelum compaction** — kalau berbeda sedikit saja, workflow berhenti dan tidak push apa pun;
4. force-push ke branch yang sama, di bawah `concurrency` group `update-calendar` supaya tidak balapan dengan refresh 15 menit.

Hasil simulasi pada clone: 163 → 54 commit, `.git` 976 KB → 342 KB, dan tree HEAD identik byte-per-byte, jadi situs tidak berubah sedikit pun. GitHub baru benar-benar membuang ruangnya setelah housekeeping server (jam–hari), dan tombol **Purge cache** pada Pages mempercepat penyajian file lama.

Karena riwayat di-rewrite, setiap clone lama (PC Windows dengan scheduled task, atau laptop ini) perlu disinkronkan sekali setelah compaction berjalan:

    git fetch origin && git reset --hard origin/main

`publish-market-data.bat` hanya menyimpan data segar di atas `origin/main`, jadi setelah satu siklus sinkron ia kembali normal. Jangan menjalankan `filter-repo`/force-push manual bersamaan dengan workflow ini — satu-satunya penulis riwayat branch adalah workflow tersebut.

Bar 1 menit di `data/markets.json` sengaja tetap 270 per aset: memotongnya jadi 60 memang lebih hemat, tapi jendela reaksi harga pasca-rilis hanya bisa dihitung mundur ±4,5 jam, sehingga badge `POST-NEWS` untuk rilis 5–6 jam sebelumnya hilang. Compaction mingguan sudah membatasi pertumbuhan sampai ±2 MB/bulan, jadi kualitas sinyal tidak dikorbankan untuk ruang. Kalau ingin commit lebih sedikit, turunkan `cron` di `update-calendar.yml` dari `*/15` ke `*/30`.


Event cards also show the pre-news market bias for affected forex majors, crosses and indices, and the card's signal badge changes from WAIT to BUY/SELL. This is an execution scenario, not a guarantee: wait for the release if the forecast edge is flat.

## Auto order grid (forex major)

`scripts/mt5_grid_hft.py` is a breakout-grid executor for EUR/USD, GBP/USD and USD/JPY: lot 0.01, grid/SL 15 pips, TP 30 pips (RR 1:2), breakeven at +1R, daily loss stop $5. News behaviour: entries are blocked ±30 minutes around impact>=2 events, and for 60 minutes after an impact>=3 event the grid/SL/TP are widened ×1.5. It is DRY-RUN by default (paper book); orders are only sent to a DEMO account with `--enable`.

    start-grid.bat                :: dry-run
    start-grid.bat --enable       :: kirim order ke akun DEMO

Do not run it at the same time as `start.bat` (news executor) on the same terminal. Logs: `bridge/grid_orders.csv`; state: `bridge/grid_state.json`. Parameters: `python scripts\mt5_grid_hft.py --help`.

### Statistik win rate & expectancy

Closed trade (PAPER mode) ditulis ke `state["trades"]` (plus log `PAPER_CLOSE` di `bridge/grid_orders.csv` dengan `pnl`). Ringkasan statistik tersedia via fungsi murni `scripts/grid_core.py::summarize_trades(trades)` — dipakai executor untuk print `trade_stats | closed=… win_rate=… profit_factor=… net_pnl=… expectancy=…` pada setiap `--once`. Closed trade juga bisa *di-seed* dari baris `PAPER_CLOSE` di `bridge/grid_orders.csv` lewat `grid_core.trades_from_order_rows(rows)`, sehingga agregasi tidak hanya bergantung state JSON.

- **win_rate** = closed trade dengan `pnl > 0` / total closed trade.
- **profit_factor** = gross win / gross loss (None bila tidak ada loss).
- **expectancy** = `(win_rate × avg_win) − ((1 − win_rate) × avg_loss)`.

Karena sinyal entry order bersifat scenario analysis, win rate ini baru meaningful setelah ada closed trade (PAPER/DONE) yang cukup; belum ada closed trade → stats kosong (`closed=0`). Untuk akun real, closed deal MT5 perlu dipasangkan ke `state["trades"]` agar agregasi seragam. Untuk sentiment pasar eksternal, `sentimentOverlay(score, aai)` di `index.html` dan `scripts/xauusd-signal-rules.js` mengambil CNN F&G Index (`score`) + AAII net % (`aai`) sebagai overlay risiko.

Dashboard (`index.html`) menampilkan panel **📊 Closed Trade Stats** (`#tradeStats`) yang membaca `data/trade-stats.json` (ditulis otomatis executor dari state + seed CSV) dan merender agregat total + breakdown **per pair** (`summarize_trades_by_pair`). Dengan begitu setiap pair market (EUR/USD, GBP/USD, USD/JPY, dst.) punya metrik win rate/profit factor/net P&L sendiri.

# aiterminaltrading
