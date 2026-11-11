"""Demo-only post-news auto-executor.

Reuses the read-only signal logic from scripts/mt5_bridge.py but can place
market orders with SL/TP. It is DRY-RUN by default: orders are only logged.
Sending requires --enable AND a DEMO account; any other account is refused.

Usage:
    python scripts/mt5_autoexec.py --once --remote
    python scripts/mt5_autoexec.py --interval 60 --remote --enable
"""

import argparse
import csv
import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import MetaTrader5 as mt5

from mt5_bridge import (
    BASE_DIR,
    PAIR_SYMBOLS,
    event_pairs,
    fmt_pair,
    kind_for,
    levels,
    live_prices,
    load_json,
    load_source,
    momentum,
    normalize_snapshot,
    parse_dt,
    resolve_symbol,
)

MAGIC = 20261028
LOG_FIELDS = [
    "logged_at", "mode", "event_date", "event", "pair", "dir", "lot",
    "price", "sl", "tp", "risk_usd", "retcode", "ticket", "status",
]


def round_volume(requested, info):
    step = float(info.volume_step or 0.01)
    low = float(info.volume_min or step)
    high = float(info.volume_max or requested)
    volume = min(max(requested, low), high)
    volume = low + round((volume - low) / step) * step
    return round(volume, 8)


def filling_mode(info):
    flags = int(info.filling_mode or 0)
    if flags & 2:
        return mt5.ORDER_FILLING_IOC
    if flags & 1:
        return mt5.ORDER_FILLING_FOK
    return mt5.ORDER_FILLING_RETURN


def spread_ok(prices, entry, sl, ratio):
    distance = abs(entry - sl)
    return distance > 0 and (prices["ask"] - prices["bid"]) <= distance * ratio


def magic_positions():
    return [p for p in (mt5.positions_get() or []) if p.magic == MAGIC]


def has_open(symbol_name):
    return any(p.symbol == symbol_name for p in magic_positions())


def append_log(path, row):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    new_file = not path.exists()
    with open(path, "a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=LOG_FIELDS)
        if new_file:
            writer.writeheader()
        writer.writerow(row)


def send_market(symbol_name, direction, lot, sl, tp, deviation):
    tick = mt5.symbol_info_tick(symbol_name)
    info = mt5.symbol_info(symbol_name)
    if not tick or not info:
        return None
    price = float(tick.ask if direction == "long" else tick.bid)
    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol_name,
        "volume": lot,
        "type": mt5.ORDER_TYPE_BUY if direction == "long" else mt5.ORDER_TYPE_SELL,
        "price": price,
        "sl": sl,
        "tp": tp,
        "deviation": deviation,
        "magic": MAGIC,
        "comment": "news-momentum",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": filling_mode(info),
    }
    return mt5.order_send(request)


def daily_guard(state, equity, max_loss, now):
    day = now.strftime("%Y-%m-%d")
    record = state.get("day") or {}
    if record.get("date") != day:
        state["day"] = {"date": day, "start_equity": equity}
        return True
    return float(record.get("start_equity", equity)) - equity < max_loss


def connect(path, enable):
    kwargs = {"path": path} if path else {}
    if not mt5.initialize(**kwargs):
        raise SystemExit(f"MT5 initialize gagal: {mt5.last_error()}")
    account, terminal = mt5.account_info(), mt5.terminal_info()
    if account is None or terminal is None:
        mt5.shutdown()
        raise SystemExit(f"Tidak bisa membaca akun/terminal MT5: {mt5.last_error()}")
    mode = {0: "DEMO", 1: "CONTEST", 2: "REAL"}.get(account.trade_mode, str(account.trade_mode))
    if enable and account.trade_mode != 0:
        mt5.shutdown()
        raise SystemExit("DITOLAK: --enable hanya diizinkan pada akun DEMO.")
    live = enable and account.trade_mode == 0
    label = "SEND (DEMO)" if live else "DRY-RUN"
    print(f"AUTOEXEC | {account.company} | {account.server} | {mode} | "
          f"balance={account.balance} {account.currency} | mode={label}", flush=True)
    if account.trade_mode != 0:
        print("PERINGATAN: akun bukan DEMO; pengiriman order dinonaktifkan.", flush=True)
    return account, live


def scan(args, state, live, equity):
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
        print(f"[{now:%H:%M:%S}Z] belum ada snapshot pra-news; tunggu workflow.", flush=True)

    cutoff = now - timedelta(days=7)
    signals = {
        k: v for k, v in (state.get("signals") or {}).items()
        if (parse_dt(v) or cutoff) >= cutoff
    }
    state["signals"] = signals
    open_count = len(magic_positions())
    matched = 0
    sent = 0
    stop = False
    missing_snap = 0

    for event in raw_events:
        event_dt = parse_dt(event.get("Date"))
        if not event_dt:
            continue
        age = (now - event_dt).total_seconds()
        if age < 0 or age > args.hold_hours * 3600:
            continue
        if int(event.get("Importance") or 1) < args.min_impact:
            continue
        key = f"{event.get('Date')}|{event.get('Event')}"
        snapshot = normalize_snapshot(snapshots.get(key))
        if not snapshot:
            missing_snap += 1
            continue

        for pair in event_pairs(event.get("Country")):
            name = resolve_symbol(PAIR_SYMBOLS[pair])
            if not name:
                continue
            prices = live_prices(pair)
            if not prices:
                continue
            mom = momentum(kind_for(pair), pair, snapshot, prices["bid"])
            if not mom:
                continue
            signal_key = f"{key}|{pair}|{mom['dir']}"
            if signal_key in signals:
                continue
            entry = prices["ask"] if mom["dir"] == "long" else prices["bid"]
            sl, tp = levels(pair, mom["dir"], entry)
            if not spread_ok(prices, entry, sl, args.spread_ratio):
                print(f"SKIP {pair} {mom['dir']}: spread terlalu lebar.", flush=True)
                continue
            info = mt5.symbol_info(name)
            if info is None:
                continue
            if not daily_guard(state, equity, args.max_daily_loss, now):
                print(f"[{now:%H:%M:%S}Z] batas rugi harian {args.max_daily_loss} USD "
                      f"tercapai (equity {equity}); berhenti.", flush=True)
                stop = True
                break
            if has_open(name):
                print(f"SKIP {pair}: sudah ada posisi executor di simbol ini.", flush=True)
                continue
            if open_count >= args.max_open:
                print(f"SKIP {pair}: batas {args.max_open} posisi terbuka.", flush=True)
                continue

            lot = round_volume(args.lot, info)
            risk_usd = abs(entry - sl) * float(info.trade_contract_size or 0) * lot
            matched += 1
            row = {
                "logged_at": now.isoformat(timespec="seconds"),
                "mode": "SEND" if live else "DRY_RUN",
                "event_date": event.get("Date"),
                "event": event.get("Event"),
                "pair": pair,
                "dir": "BUY" if mom["dir"] == "long" else "SELL",
                "lot": lot,
                "price": fmt_pair(pair, entry),
                "sl": fmt_pair(pair, sl),
                "tp": fmt_pair(pair, tp),
                "risk_usd": f"{risk_usd:.2f}",
                "retcode": "",
                "ticket": "",
                "status": "DRY_RUN",
            }

            if not live:
                append_log(args.log, row)
                signals[signal_key] = now.isoformat(timespec="seconds")
                print(f"DRY-RUN {row['logged_at']} {pair} {row['dir']} lot={lot} "
                      f"entry={row['price']} SL={row['sl']} TP={row['tp']} "
                      f"risk=${row['risk_usd']} ({mom['change_pct']:+.2f}%) | {row['event']}", flush=True)
                continue

            result = send_market(name, mom["dir"], lot, sl, tp, args.deviation)
            if result is None:
                print(f"ORDER GAGAL {pair}: tidak ada respons dari terminal.", flush=True)
                continue
            done = result.retcode == mt5.TRADE_RETCODE_DONE
            row["retcode"] = result.retcode
            row["ticket"] = getattr(result, "order", "")
            row["status"] = "SENT" if done else f"REJECTED {result.comment or ''}".strip()
            append_log(args.log, row)
            if done:
                signals[signal_key] = now.isoformat(timespec="seconds")
                open_count += 1
                sent += 1
                print(f"SENT {pair} {row['dir']} lot={lot} entry={row['price']} "
                      f"SL={row['sl']} TP={row['tp']} risk=${row['risk_usd']} "
                      f"ticket={row['ticket']}", flush=True)
            else:
                print(f"REJECTED {pair} {row['dir']} retcode={result.retcode} "
                      f"{result.comment or ''}", flush=True)
        if stop:
            break

    if args.once and matched == 0:
        print(f"tidak ada sinyal (event tanpa snapshot: {missing_snap}).", flush=True)
    return state, sent, stop


def main():
    parser = argparse.ArgumentParser(description="Demo-only post-news momentum executor")
    parser.add_argument("--enable", action="store_true", help="kirim order (hanya akun DEMO)")
    parser.add_argument("--once", action="store_true", help="satu kali scan lalu keluar")
    parser.add_argument("--interval", type=int, default=60, help="detik antar scan (default 60)")
    parser.add_argument("--calendar", default=None, help="path lokal atau URL")
    parser.add_argument("--prenews", default=None, help="path lokal atau URL")
    parser.add_argument("--remote", action="store_true", help="baca data dari GitHub main")
    parser.add_argument("--log", default=str(BASE_DIR / "bridge" / "orders.csv"))
    parser.add_argument("--state", default=str(BASE_DIR / "bridge" / "autoexec_state.json"))
    parser.add_argument("--hold-hours", type=float, default=6)
    parser.add_argument("--min-impact", type=int, default=2)
    parser.add_argument("--lot", type=float, default=0.01, help="volume diminta (dibatasi spesifikasi simbol)")
    parser.add_argument("--max-open", type=int, default=3, help="maks posisi terbuka milik executor")
    parser.add_argument("--max-daily-loss", type=float, default=20.0, help="USD; stop jika equity turun sebesar ini")
    parser.add_argument("--spread-ratio", type=float, default=0.25, help="spread maks terhadap jarak SL")
    parser.add_argument("--deviation", type=int, default=50, help="slippage maks dalam points")
    parser.add_argument("--path", default=None, help="path terminal MT5 opsional")
    args = parser.parse_args()

    if args.remote:
        args.calendar = args.calendar or "https://raw.githubusercontent.com/pitoyict13-droid/aiterminaltrading/main/data/calendar.json"
        args.prenews = args.prenews or "https://raw.githubusercontent.com/pitoyict13-droid/aiterminaltrading/main/data/prenews.json"
    else:
        args.calendar = args.calendar or str(BASE_DIR / "data" / "calendar.json")
        args.prenews = args.prenews or str(BASE_DIR / "data" / "prenews.json")

    print(f"source: {args.calendar} | {args.prenews}", flush=True)
    account, live = connect(args.path, args.enable)
    state = load_json(args.state, {})
    state = state if isinstance(state, dict) else {}

    try:
        while True:
            account = mt5.account_info() or account
            equity = float(getattr(account, "equity", 0.0))
            state, _, stop = scan(args, state, live, equity)
            Path(args.state).parent.mkdir(parents=True, exist_ok=True)
            with open(args.state, "w", encoding="utf-8") as f:
                json.dump(state, f, indent=2)
            if args.once or stop:
                break
            time.sleep(max(15, args.interval))
    except KeyboardInterrupt:
        print("Executor dihentikan; posisi terbuka tetap memakai SL/TP masing-masing.", flush=True)
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    main()
