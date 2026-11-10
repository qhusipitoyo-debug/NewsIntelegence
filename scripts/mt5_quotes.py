#!/usr/bin/env python3
"""Export exact MT5 broker bid/ask quotes for the public forex board.

The GitHub Actions runner cannot reach the user's MetaTrader terminal, so this
script runs locally on the Windows PC that has MT5 logged in. It writes only
market data: broker name/server/account type (demo/real/contest) plus bid/ask.
Login numbers, balance, equity and credentials are never written.

Usage:
    python scripts/mt5_quotes.py
    python scripts/mt5_quotes.py --out data/forex-broker.json
    python scripts/mt5_quotes.py --print
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_OUT = BASE_DIR / "data" / "forex-broker.json"

# Pair -> canonical MT5 symbol (without broker suffix).
# - XAU/USD wajib ada: gold adalah aset fokus untuk news USD, dan level entry
#   emas di terminal hanya akurat kalau memakai bid/ask broker yang sama
#   (api.gold-api.com adalah harga spot referensi, bukan harga eksekusi broker).
# - NAS100/US500 wajib ada: broker mengeksekusi CFD berbasis FUTURES (NQ/ES),
#   sedangkan sumber lain menampilkan indeks CASH (^NDX/^GSPC) yang bedanya
#   bisa puluhan-ratusan poin. Nilainya boleh berupa tuple kandidat karena
#   nama simbol indeks berbeda antar broker.
PAIR_SYMBOLS = {
    "EUR/USD": "EURUSD",
    "GBP/USD": "GBPUSD",
    "USD/JPY": "USDJPY",
    "USD/CHF": "USDCHF",
    "AUD/USD": "AUDUSD",
    "USD/CAD": "USDCAD",
    "NZD/USD": "NZDUSD",
    "GBP/JPY": "GBPJPY",
    "EUR/JPY": "EURJPY",
    "XAU/USD": "XAUUSD",
    "NAS100": ("NAS100", "USTEC", "US100"),
    "US500": ("SP500", "US500", "SPX500"),
}

# Known broker fingerprints. The first matching token wins, so put the most
# specific names first. Unknown brokers still work; they get a normalized id.
BROKER_HINTS = (
    ("GOMARKETS", ("GO MARKETS", "GOMARKETS", "GO_MARKETS")),
    ("CMCMARKETS", ("CMC MARKETS", "CMCMARKETS", "CMC_MARKETS")),
    ("FPMARKETS", ("FP MARKETS", "FPMARKETS", "FP_MARKETS")),
    ("EXNESS", ("EXNESS",)),
    ("FBS", ("FBS",)),
)

ACCOUNT_TYPES = {0: "demo", 1: "contest", 2: "real"}

# The public board treats a payload older than this as stale (two missed runs).
STALE_AFTER_SEC = 30 * 60


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def broker_id(company: str, server: str) -> str:
    haystack = f"{company or ''} {server or ''}".upper()
    for ident, tokens in BROKER_HINTS:
        if any(token in haystack for token in tokens):
            return ident
    clean = "".join(ch for ch in (company or server or "MT5").upper() if ch.isalnum())
    return clean[:24] or "MT5"


def account_type(trade_mode) -> str:
    try:
        return ACCOUNT_TYPES.get(int(trade_mode), "unknown")
    except (TypeError, ValueError):
        return "unknown"


def pip_size(pair: str, digits) -> float:
    if "/" not in pair:
        # Indeks CFD (NAS100/US500): 1 poin = 1.0.
        return 1.0
    base = pair.split("/")[0].upper()
    quote = pair.split("/")[-1].upper()
    if base == "XAU" or quote == "JPY":
        return 0.01
    if isinstance(digits, int) and digits >= 4:
        return 10 ** -(digits - 1)
    return 0.0001


def resolve_symbol(mt5, canonical, cache) -> str | None:
    """Return the broker's real symbol name, tolerant of suffixes/prefixes.

    `canonical` can be a single name or a tuple of candidate names (index CFDs
    are named differently across brokers); the first that resolves wins.
    """
    if canonical in cache:
        return cache[canonical]

    candidates_list = canonical if isinstance(canonical, tuple) else (canonical,)
    info = None
    for candidate in candidates_list:
        info = mt5.symbol_info(candidate)
        if info is not None:
            break
    if info is None:
        candidates = []
        for symbol in mt5.symbols_get() or []:
            name = symbol.name.upper()
            for candidate in candidates_list:
                if name == candidate:
                    candidates.append((0, symbol.name))
                elif name.startswith(candidate) and len(name) > len(candidate):
                    tail = name[len(candidate):]
                    # Prefer common suffix separators, then any suffix.
                    rank = 1 if tail[0] in "._-#" else 2
                    candidates.append((rank, symbol.name))
        if candidates:
            candidates.sort(key=lambda item: (item[0], len(item[1]), item[1]))
            info = mt5.symbol_info(candidates[0][1])

    if info is None:
        return None
    if not info.visible:
        mt5.symbol_select(info.name, True)
    cache[canonical] = info.name
    return info.name


def collect_quotes(mt5, now: datetime) -> dict:
    quotes = {}
    cache: dict[str, str] = {}
    for pair, canonical in PAIR_SYMBOLS.items():
        name = resolve_symbol(mt5, canonical, cache)
        if not name:
            print(f"[skip] {pair}: symbol {canonical} not found", file=sys.stderr)
            continue

        tick = mt5.symbol_info_tick(name)
        if tick is None or not tick.bid or not tick.ask:
            print(f"[skip] {pair}: no bid/ask for {name}", file=sys.stderr)
            continue

        info = mt5.symbol_info(name)
        digits = info.digits if info is not None else (
            2 if pair.startswith("XAU") or "/" not in pair
            else (3 if pair.endswith("JPY") else 5)
        )
        bid = float(tick.bid)
        ask = float(tick.ask)
        if bid <= 0 or ask <= 0 or ask < bid:
            print(f"[skip] {pair}: invalid quote bid={bid} ask={ask}", file=sys.stderr)
            continue

        pip = pip_size(pair, digits)
        spread = ask - bid
        # MT5 reports tick.time on the broker's server clock (often UTC+2/+3),
        # not true UTC, so keep it as a display-only broker time. The public UI
        # measures freshness from generatedAt, which is real UTC.
        tick_dt = datetime.fromtimestamp(int(tick.time), tz=timezone.utc)
        quotes[pair] = {
            "bid": round(bid, digits),
            "ask": round(ask, digits),
            "mid": round((bid + ask) / 2, digits),
            "spread": round(spread, digits),
            "spreadPips": round(spread / pip, 2),
            "digits": int(digits),
            "symbol": name,
            "brokerTime": iso(tick_dt),
        }
    return quotes


def build_payload(mt5, now: datetime | None = None) -> dict:
    now = now or utc_now()
    account = mt5.account_info()
    if account is None:
        raise RuntimeError(f"account_info() failed: {mt5.last_error()}")

    company = getattr(account, "company", "") or ""
    server = getattr(account, "server", "") or ""
    q = collect_quotes(mt5, now)
    if not q:
        raise RuntimeError("no tradable forex quotes were available")

    biz = broker_id(company, server)
    return {
        "generatedAt": iso(now),
        "source": "MT5 local bridge",
        # Keep the public payload minimal: broker family and demo/real status,
        # not the user's installed terminal or live server name.
        "broker": {
            "id": biz,
            "name": biz,
            "accountType": account_type(getattr(account, "trade_mode", None)),
        },
        "quotes": q,
        "providers": {
            biz: {"name": biz, "status": "ok", "pairs": len(q)}
        },
        "staleAfterSec": STALE_AFTER_SEC,
    }


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description="Export MT5 broker bid/ask for the forex board")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help=f"output path (default: {DEFAULT_OUT})")
    parser.add_argument("--print", action="store_true", help="print the payload as well as writing it")
    parser.add_argument("--quiet", action="store_true", help="only print errors")
    args = parser.parse_args()

    try:
        import MetaTrader5 as mt5
    except ImportError:
        print("MetaTrader5 package is missing. Run: python -m pip install MetaTrader5", file=sys.stderr)
        return 2

    if not mt5.initialize():
        print(f"MT5 initialize failed: {mt5.last_error()}", file=sys.stderr)
        return 1

    try:
        payload = build_payload(mt5)
    except Exception as exc:  # noqa: BLE001 - report any bridge failure clearly
        print(f"MT5 quote export failed: {exc}", file=sys.stderr)
        return 1
    finally:
        mt5.shutdown()

    out = Path(args.out)
    write_json(out, payload)
    if args.print:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    if not args.quiet:
        broker = payload["broker"]
        print(
            f"Wrote {len(payload['quotes'])} quotes from {broker['name']} "
            f"({broker['server']}, {broker['accountType']}) -> {out}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
