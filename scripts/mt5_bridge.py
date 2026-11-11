"""Read-only MT5 signal bridge.

Reads data/calendar.json + data/prenews.json, compares the pre-news snapshot with
live MT5 prices, and records post-news momentum signals. It never sends orders.

Usage:
    python scripts/mt5_bridge.py --once --remote
    python scripts/mt5_bridge.py --interval 60 --remote
    python scripts/mt5_bridge.py --once            # uses local data/*.json
"""

import argparse
import csv
import json
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import MetaTrader5 as mt5

BASE_DIR = Path(__file__).resolve().parent.parent
RAW_BASE = "https://raw.githubusercontent.com/pitoyict13-droid/aiterminaltrading/main"
PAIR_SYMBOLS = {
    "XAU/USD": "XAUUSD",
    "EUR/USD": "EURUSD",
    "GBP/USD": "GBPUSD",
    "USD/JPY": "USDJPY",
    "USD/CHF": "USDCHF",
    "AUD/USD": "AUDUSD",
    "USD/CAD": "USDCAD",
    "BTC/USD": "BTCUSD",
    "ETH/USD": "ETHUSD",
}
FOREX_PAIRS = ["EUR/USD", "GBP/USD", "USD/JPY", "USD/CHF", "AUD/USD", "USD/CAD"]
DIGITS = {"XAU/USD": 2, "BTC/USD": 2, "ETH/USD": 2}
FIELDS = ["logged_at", "event_date", "event", "country", "importance", "pair", "dir",
          "base", "current", "change_pct", "entry", "sl", "tp", "valid_until"]
_symbol_cache = {}


def parse_dt(value):
    try:
        d = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def to_float(value):
    try:
        v = float(value)
        return v if v > 0 else None
    except (TypeError, ValueError):
        return None


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def load_source(source, default, cache_bust=False):
    source = str(source or default)
    if source.startswith(("http://", "https://")):
        url = source
        if cache_bust:
            url += ("&" if "?" in url else "?") + f"t={int(time.time())}"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "feriha-bridge"})
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:
            print(f"Gagal mengambil {url}: {e}", flush=True)
            return None
    return load_json(source, None)


def pair_rate(rates, pair):
    if not rates:
        return None
    if pair == "EUR/USD":
        return 1 / rates["EUR"] if rates.get("EUR") else None
    if pair == "GBP/USD":
        return 1 / rates["GBP"] if rates.get("GBP") else None
    if pair == "AUD/USD":
        return 1 / rates["AUD"] if rates.get("AUD") else None
    if pair == "USD/JPY":
        return rates.get("JPY")
    if pair == "USD/CHF":
        return rates.get("CHF")
    if pair == "USD/CAD":
        return rates.get("CAD")
    return None


def kind_for(pair):
    if pair == "XAU/USD":
        return "gold"
    if pair in ("BTC/USD", "ETH/USD"):
        return "crypto"
    return "forex"


def normalize_snapshot(entry):
    if entry is None:
        return None
    if isinstance(entry, (int, float)):
        return {"gold": float(entry)}
    if not isinstance(entry, dict):
        return None
    snap = dict(entry)
    if snap.get("gold") is None and snap.get("price") is not None:
        snap["gold"] = to_float(snap["price"])
    snap.pop("price", None)
    return snap


def event_pairs(country):
    c = str(country or "").upper()
    if c == "USD":
        return list(PAIR_SYMBOLS)
    return {
        "AUD": ["AUD/USD"],
        "EUR": ["EUR/USD"],
        "GBP": ["GBP/USD"],
        "JPY": ["USD/JPY"],
        "CHF": ["USD/CHF"],
        "CAD": ["USD/CAD"],
    }.get(c, [])


def resolve_symbol(base):
    if base in _symbol_cache:
        return _symbol_cache[base]
    info = mt5.symbol_info(base)
    if info is None:
        for s in mt5.symbols_get() or []:
            name = s.name.upper()
            if name == base or name.startswith(base + ".") or name.startswith(base + "_"):
                info = s
                break
    if info is None:
        return None
    if not info.visible:
        mt5.symbol_select(info.name, True)
    _symbol_cache[base] = info.name
    return info.name


def live_prices(pair):
    name = resolve_symbol(PAIR_SYMBOLS[pair])
    if not name:
        return None
    tick = mt5.symbol_info_tick(name)
    if not tick or not tick.bid or not tick.ask:
        return None
    return {"bid": float(tick.bid), "ask": float(tick.ask)}


def momentum(kind, pair, snap, bid):
    if kind == "gold":
        base = to_float(snap.get("gold"))
    elif kind == "crypto":
        base = to_float((snap.get("crypto") or {}).get(pair))
    else:
        base = pair_rate(snap.get("forex"), pair)
    if not base or not bid:
        return None
    change = (bid - base) / base * 100
    if abs(change) < 0.1:
        return None
    return {"dir": "long" if change > 0 else "short", "base": base, "change_pct": change}


def levels(pair, direction, entry):
    if pair == "XAU/USD":
        sl_pct, tp_pct = 0.5, 1.0
    elif pair == "BTC/USD":
        sl_pct, tp_pct = 1.0, 2.0
    elif pair == "ETH/USD":
        sl_pct, tp_pct = 1.5, 3.0
    else:
        dist = (0.30, 0.60) if pair == "USD/JPY" else (0.0030, 0.0060)
        sl = entry - dist[0] if direction == "long" else entry + dist[0]
        tp = entry + dist[1] if direction == "long" else entry - dist[1]
        return sl, tp
    sl = entry * (1 - sl_pct / 100) if direction == "long" else entry * (1 + sl_pct / 100)
    tp = entry * (1 + tp_pct / 100) if direction == "long" else entry * (1 - tp_pct / 100)
    return sl, tp


def fmt_pair(pair, value):
    return f"{value:.{DIGITS.get(pair, 5)}f}"


def append_csv(path, row):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    new_file = not path.exists()
    with open(path, "a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS)
        if new_file:
            writer.writeheader()
        writer.writerow(row)


def prune_state(state, now):
    cutoff = now - timedelta(days=7)
    return {k: v for k, v in state.items() if (parse_dt(v) or cutoff) >= cutoff}


def scan(args, state):
    now = datetime.now(timezone.utc)
    raw_events = load_source(args.calendar, None, cache_bust=True)
    if isinstance(raw_events, dict):
        raw_events = raw_events.get("events", [])
    if not isinstance(raw_events, list):
        raw_events = []
    snapshots = load_source(args.prenews, None, cache_bust=True)
    if not isinstance(snapshots, dict):
        snapshots = {}
    if not snapshots:
        print(f"[{now:%H:%M:%S}Z] belum ada snapshot pra-news di {args.prenews}; tunggu workflow.", flush=True)

    new_signals = []
    missing_snap = 0
    for ev in raw_events or []:
        event_dt = parse_dt(ev.get("Date"))
        if not event_dt:
            continue
        age = (now - event_dt).total_seconds()
        if age < 0 or age > args.hold_hours * 3600:
            continue
        if int(ev.get("Importance") or 1) < args.min_impact:
            continue
        key = f"{ev.get('Date')}|{ev.get('Event')}"
        snap = normalize_snapshot(snapshots.get(key))
        if not snap:
            missing_snap += 1
            continue
        for pair in event_pairs(ev.get("Country")):
            prices = live_prices(pair)
            if not prices:
                continue
            mom = momentum(kind_for(pair), pair, snap, prices["bid"])
            if not mom:
                continue
            sig_key = f"{key}|{pair}|{mom['dir']}"
            if sig_key in state:
                continue
            entry = prices["ask"] if mom["dir"] == "long" else prices["bid"]
            sl, tp = levels(pair, mom["dir"], entry)
            row = {
                "logged_at": now.isoformat(timespec="seconds"),
                "event_date": ev.get("Date"),
                "event": ev.get("Event"),
                "country": ev.get("Country"),
                "importance": ev.get("Importance"),
                "pair": pair,
                "dir": "BUY" if mom["dir"] == "long" else "SELL",
                "base": fmt_pair(pair, mom["base"]),
                "current": fmt_pair(pair, prices["bid"]),
                "change_pct": f"{mom['change_pct']:+.2f}",
                "entry": fmt_pair(pair, entry),
                "sl": fmt_pair(pair, sl),
                "tp": fmt_pair(pair, tp),
                "valid_until": (event_dt + timedelta(hours=args.hold_hours)).isoformat(timespec="minutes"),
            }
            append_csv(args.log, row)
            state[sig_key] = now.isoformat(timespec="seconds")
            new_signals.append(row)

    if new_signals:
        for row in new_signals:
            print(f"SIGNAL {row['logged_at']} {row['pair']} {row['dir']} "
                  f"base={row['base']} now={row['current']} ({row['change_pct']}%) "
                  f"entry={row['entry']} SL={row['sl']} TP={row['tp']} | {row['event']}", flush=True)
    elif args.once:
        print(f"[{now:%H:%M:%S}Z] tidak ada sinyal baru "
              f"(event tanpa snapshot: {missing_snap}, snapshot tersimpan: {len(snapshots)}).", flush=True)

    return state, len(new_signals)


def connect(path=None):
    kwargs = {"path": path} if path else {}
    if not mt5.initialize(**kwargs):
        raise SystemExit(f"MT5 initialize gagal: {mt5.last_error()}")
    ai = mt5.account_info()
    ti = mt5.terminal_info()
    if ai is None or ti is None:
        mt5.shutdown()
        raise SystemExit(f"Tidak bisa membaca akun/terminal MT5: {mt5.last_error()}")
    mode = {0: "DEMO", 1: "CONTEST", 2: "REAL"}.get(ai.trade_mode, str(ai.trade_mode))
    print(f"ALERT-ONLY | {ai.company} | {ai.server} | {mode} | "
          f"balance={ai.balance} {ai.currency} | terminal={ti.path}", flush=True)
    if ai.trade_mode != 0:
        print("PERINGATAN: akun bukan DEMO. Bridge ini hanya membaca, tidak pernah mengirim order.", flush=True)


def main():
    parser = argparse.ArgumentParser(description="Read-only MT5 post-news momentum alerts")
    parser.add_argument("--once", action="store_true", help="single scan then exit")
    parser.add_argument("--interval", type=int, default=60, help="seconds between scans")
    parser.add_argument("--calendar", default=None, help="local path or URL")
    parser.add_argument("--prenews", default=None, help="local path or URL")
    parser.add_argument("--remote", action="store_true", help="read calendar/prenews from GitHub main")
    parser.add_argument("--log", default=str(BASE_DIR / "bridge" / "signals.csv"))
    parser.add_argument("--state", default=str(BASE_DIR / "bridge" / "state.json"))
    parser.add_argument("--hold-hours", type=float, default=6)
    parser.add_argument("--min-impact", type=int, default=2)
    parser.add_argument("--path", default=None, help="optional MT5 terminal path")
    args = parser.parse_args()
    if args.remote:
        args.calendar = args.calendar or f"{RAW_BASE}/data/calendar.json"
        args.prenews = args.prenews or f"{RAW_BASE}/data/prenews.json"
    else:
        args.calendar = args.calendar or str(BASE_DIR / "data" / "calendar.json")
        args.prenews = args.prenews or str(BASE_DIR / "data" / "prenews.json")

    print(f"source: {args.calendar} | {args.prenews}", flush=True)
    connect(args.path)
    state = load_json(args.state, {})
    state = prune_state(state if isinstance(state, dict) else {}, datetime.now(timezone.utc))
    try:
        while True:
            state, _ = scan(args, state)
            Path(args.state).parent.mkdir(parents=True, exist_ok=True)
            with open(args.state, "w", encoding="utf-8") as f:
                json.dump(state, f, indent=2)
            if args.once:
                break
            time.sleep(max(15, args.interval))
    except KeyboardInterrupt:
        print("Bridge dihentikan.", flush=True)
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    main()
