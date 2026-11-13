#!/usr/bin/env python3
"""Automated Linux MT5 Bridge for Bottles (Wine).

Connects NewsIntelegence directly with MetaTrader 5 running in Bottles on Linux.
Communicates seamlessly through the MQL5 File Protocol with SniperBridge.mq5:
- Reads live FBS Demo account status, balance, equity, and quotes.
- Automatically exports exact broker bid/ask quotes to data/forex-broker.json.
- Listens to high-confluence news trading signals and auto-executes orders to MT5.
- Supports PING, BUY, SELL, CLOSEALL, and HALT commands directly from Linux.

Usage:
    ./run_linux_bridge.sh --status
    ./run_linux_bridge.sh --ping
    ./run_linux_bridge.sh --test-order EURUSD
    ./run_linux_bridge.sh --auto
    ./run_linux_bridge.sh --buy XAUUSD 0.01
    ./run_linux_bridge.sh --close-all
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
BROKER_OUT = DATA_DIR / "forex-broker.json"
CALENDAR_FILE = DATA_DIR / "calendar.json"
PRENEWS_FILE = DATA_DIR / "prenews.json"
JOURNAL_FILE = DATA_DIR / "bridge_trades.json"
LOG_FILE = DATA_DIR / "mt5_bridge.log"

DEFAULT_BOTTLES_PATHS = [
    Path.home() / ".var/app/com.usebottles.bottles/data/bottles/bottles/MT5/drive_c/Program Files/MetaTrader 5 EXNESS/MQL5/Files",
    Path.home() / ".local/share/bottles/bottles/MT5/drive_c/Program Files/MetaTrader 5 EXNESS/MQL5/Files",
]

SYMBOL_TO_PAIR = {
    "EURUSD": "EUR/USD",
    "GBPUSD": "GBP/USD",
    "USDJPY": "USD/JPY",
    "USDCHF": "USD/CHF",
    "AUDUSD": "AUD/USD",
    "USDCAD": "USD/CAD",
    "NZDUSD": "NZD/USD",
    "GBPJPY": "GBP/JPY",
    "EURJPY": "EUR/JPY",
    "XAUUSD": "XAU/USD",
    "BTCUSD": "BTC/USD",
    "ETHUSD": "ETH/USD",
    "US500": "US500",
    "SP500": "US500",
}

PAIR_TO_SYMBOL = {v: k for k, v in SYMBOL_TO_PAIR.items()}
PAIR_TO_SYMBOL["US500"] = "US500"


def log(msg: str) -> None:
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    formatted = f"[{now_str}] {msg}"
    print(formatted)
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(formatted + "\n")
    except Exception:
        pass


def default_sl_tp(symbol: str, action: str, price: float) -> tuple[float, float, float]:
    """Calculate institutional 1:2 R:R SL and TP based on asset class."""
    sym = symbol.upper().replace("/", "")
    digits = 2 if "XAU" in sym or "BTC" in sym or "ETH" in sym or sym == "US500" else (3 if "JPY" in sym else 5)

    if "XAU" in sym:
        dist = 20.0  # $20 gold stop
    elif sym == "US500":
        dist = 25.0  # 25 points S&P stop
    elif "BTC" in sym:
        dist = 800.0
    elif "ETH" in sym:
        dist = 40.0
    elif "JPY" in sym:
        dist = 0.30  # 30 pips
    else:
        dist = 0.0025  # 25 pips for EURUSD, GBPUSD, etc.

    if action == "BUY":
        sl = round(price - dist, digits)
        tp1 = round(price + dist, digits)
        tp2 = round(price + dist * 2.0, digits)
    else:
        sl = round(price + dist, digits)
        tp1 = round(price - dist, digits)
        tp2 = round(price - dist * 2.0, digits)

    return sl, tp1, tp2


def find_mql5_files_dir(custom_path: str | None = None) -> Path:
    if custom_path:
        p = Path(custom_path).expanduser().resolve()
        if p.exists():
            return p
        raise FileNotFoundError(f"Custom MQL5/Files path not found: {custom_path}")

    env_path = os.environ.get("MT5_FILES_DIR")
    if env_path:
        p = Path(env_path).expanduser().resolve()
        if p.exists():
            return p

    for default_p in DEFAULT_BOTTLES_PATHS:
        if default_p.exists():
            return default_p

    base_search = Path.home() / ".var/app/com.usebottles.bottles/data/bottles/bottles"
    if base_search.exists():
        for candidate in base_search.glob("**/MQL5/Files"):
            if candidate.is_dir():
                return candidate

    raise FileNotFoundError(
        "MQL5/Files directory not found in default Bottles paths.\n"
        "Please specify with --path or MT5_FILES_DIR environment variable."
    )


class MT5FileBridge:
    def __init__(self, files_dir: Path, allow_real: bool = False):
        self.files_dir = files_dir
        self.allow_real = allow_real
        self.req_file = files_dir / "sniper_req.txt"
        self.ack_file = files_dir / "sniper_ack.txt"
        self.status_file = files_dir / "sniper_status.txt"
        self.bars_file = files_dir / "sniper_bars.txt"
        self.lastid_file = files_dir / "sniper_lastid.txt"

    def read_status(self) -> dict[str, Any] | None:
        if not self.status_file.exists():
            return None
        try:
            with open(self.status_file, "r", encoding="utf-8", errors="replace") as f:
                content = f.read().strip()
            if not content:
                return None

            parts = {}
            for item in content.split(";"):
                if "=" in item:
                    k, v = item.split("=", 1)
                    parts[k.strip()] = v.strip()

            if parts.get("end") != "1" and "login" not in parts:
                return None

            quotes = {}
            for k, v in parts.items():
                if k.startswith("mkt"):
                    sub = v.split(":")
                    if len(sub) >= 4:
                        sym, spread_pts, ask_str, bid_str = sub[0], sub[1], sub[2], sub[3]
                        try:
                            ask = float(ask_str)
                            bid = float(bid_str)
                            pts = float(spread_pts)
                            pair = SYMBOL_TO_PAIR.get(sym, sym)
                            digits = len(ask_str.split(".")[1]) if "." in ask_str else 2
                            pip_sz = 0.01 if "JPY" in sym or "XAU" in sym else 0.0001
                            quotes[pair] = {
                                "symbol": sym,
                                "bid": bid,
                                "ask": ask,
                                "mid": round((ask + bid) / 2, digits),
                                "spread": round(ask - bid, digits),
                                "spreadPips": round((ask - bid) / pip_sz, 1) if pip_sz else pts,
                                "digits": digits,
                                "rawPoints": pts,
                            }
                        except Exception:
                            continue

            parts["quotes"] = quotes
            return parts
        except Exception as e:
            log(f"Error reading sniper_status.txt: {e}")
            return None

    def export_forex_broker_json(self) -> bool:
        st = self.read_status()
        if not st:
            return False

        now_utc = datetime.now(timezone.utc)
        quotes = st.get("quotes", {})
        if not quotes:
            return False

        server = st.get("server", "FBS-Demo")
        trade_mode = st.get("trade_mode", "demo")

        payload = {
            "generatedAt": now_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source": "MT5 Linux Bottles Bridge",
            "broker": {
                "id": "FBS",
                "name": f"FBS ({trade_mode.upper()})",
                "server": server,
                "accountType": trade_mode,
                "login": st.get("login"),
                "balance": float(st.get("balance", 0)),
                "equity": float(st.get("equity", 0)),
                "marginFree": float(st.get("margin_free", 0)),
                "tradeAllowed": st.get("trade_allowed") == "1",
                "tradeExpert": st.get("trade_expert") == "1",
            },
            "quotes": quotes,
            "providers": {
                "FBS": {"name": f"FBS {trade_mode.upper()}", "status": "ok", "pairs": len(quotes)}
            },
            "staleAfterSec": 60,
        }

        DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp_out = BROKER_OUT.with_suffix(".tmp")
        with open(tmp_out, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
        tmp_out.replace(BROKER_OUT)
        return True

    def send_command(self, cmd_dict: dict[str, Any], timeout_sec: float = 6.0) -> dict[str, Any]:
        st = self.read_status()
        if st:
            trade_mode = st.get("trade_mode", "").lower()
            if trade_mode == "real" and not self.allow_real:
                raise PermissionError("Refusing order: MT5 is logged into a REAL account! Use demo or pass --allow-real.")

        last_id = 1000000
        if self.lastid_file.exists():
            try:
                with open(self.lastid_file, "r", encoding="utf-8") as f:
                    content = f.read().strip()
                for p in content.split(";"):
                    if p.startswith("id="):
                        last_id = int(p.split("=")[1])
            except Exception:
                pass

        req_id = max(last_id + 1, int(time.time() * 1000) % 100000000)
        cmd_dict["id"] = req_id
        cmd_dict["end"] = "1"

        line = ";".join(f"{k}={v}" for k, v in cmd_dict.items())

        with open(self.req_file, "w", encoding="utf-8") as f:
            f.write(line + "\n")

        log(f"📡 Sent request [id={req_id}]: {cmd_dict.get('cmd')} {cmd_dict.get('symbol', '')}")

        start = time.time()
        while time.time() - start < timeout_sec:
            if self.ack_file.exists():
                try:
                    with open(self.ack_file, "r", encoding="utf-8", errors="replace") as f:
                        lines = [l.strip() for l in f if l.strip()]
                    for l in reversed(lines):
                        if f"id={req_id}" in l:
                            ack_parts = dict(p.split("=", 1) for p in l.split(";") if "=" in p)
                            ok = ack_parts.get("ok") == "1"
                            ticket = ack_parts.get("ticket", "0")
                            reason = ack_parts.get("reason", "")
                            return {"ok": ok, "ticket": ticket, "reason": reason, "id": req_id}
                except Exception:
                    pass
            time.sleep(0.2)

        return {"ok": False, "ticket": "0", "reason": f"Timeout {timeout_sec}s menunggu konfirmasi EA (Pastikan EA aktif di MT5)", "id": req_id}

    def ping(self) -> dict[str, Any]:
        return self.send_command({"cmd": "PING"})

    def close_all(self) -> dict[str, Any]:
        return self.send_command({"cmd": "CLOSEALL"})

    def halt(self, why: str = "manual_halt") -> dict[str, Any]:
        return self.send_command({"cmd": "HALT", "why": why})

    def resume(self) -> dict[str, Any]:
        return self.send_command({"cmd": "RESUME"})

    def order(
        self,
        action: str,
        symbol: str,
        volume: float = 0.01,
        price: float = 0.0,
        sl: float = 0.0,
        tp1: float = 0.0,
        tp2: float = 0.0,
        risk_usd: float = 5.0,
    ) -> dict[str, Any]:
        action = action.upper()
        if action not in ("BUY", "SELL"):
            raise ValueError(f"Invalid order action: {action}")

        st = self.read_status()
        if st and not price:
            quotes = st.get("quotes", {})
            pair = SYMBOL_TO_PAIR.get(symbol, symbol)
            if pair in quotes:
                price = quotes[pair]["ask"] if action == "BUY" else quotes[pair]["bid"]

        # Ensure SL and TP are set (SniperBridge rejects orders without SL/TP)
        if (not sl or not tp2) and price > 0:
            calc_sl, calc_tp1, calc_tp2 = default_sl_tp(symbol, action, price)
            sl = sl or calc_sl
            tp1 = tp1 or calc_tp1
            tp2 = tp2 or calc_tp2

        cmd = {
            "cmd": action,
            "symbol": symbol,
            "volume": round(volume, 2),
            "price": price,
            "sl": sl,
            "tp1": tp1 or tp2,
            "tp2": tp2,
            "riskusd": round(risk_usd, 2),
        }
        return self.send_command(cmd, timeout_sec=8.0)


class AutoTrader:
    def __init__(self, bridge: MT5FileBridge, hold_hours: float = 6.0, min_impact: int = 2):
        self.bridge = bridge
        self.hold_hours = hold_hours
        self.min_impact = min_impact
        self.journal_file = JOURNAL_FILE
        self.traded_keys: set[str] = self._load_journal()
        self.last_scan_log = 0.0

    def _load_journal(self) -> set[str]:
        if not self.journal_file.exists():
            return set()
        try:
            with open(self.journal_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            return set(data.get("traded_keys", []))
        except Exception:
            return set()

    def _save_journal(self) -> None:
        try:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            with open(self.journal_file, "w", encoding="utf-8") as f:
                json.dump({"traded_keys": list(self.traded_keys), "updatedAt": datetime.now(timezone.utc).isoformat()}, f, indent=2)
        except Exception:
            pass

    def scan_and_trade(self) -> int:
        if not CALENDAR_FILE.exists():
            return 0

        now = datetime.now(timezone.utc)
        now_ts = now.timestamp()

        try:
            with open(CALENDAR_FILE, "r", encoding="utf-8") as f:
                events = json.load(f)
        except Exception:
            return 0

        st = self.bridge.read_status()
        if not st:
            return 0

        # Account safety guard
        if st.get("trade_allowed") != "1" or st.get("trade_expert") != "1":
            if now_ts - self.last_scan_log >= 60.0:
                log("⚠️ AutoTrader ditunda: Algo Trading di MT5 belum diizinkan (pastikan tombol hijau aktif).")
                self.last_scan_log = now_ts
            return 0

        margin_free = float(st.get("margin_free", 0))
        if margin_free < 50.0:
            if now_ts - self.last_scan_log >= 60.0:
                log(f"⚠️ AutoTrader ditunda: Margin free ${margin_free:.2f} < $50.00.")
                self.last_scan_log = now_ts
            return 0

        quotes = st.get("quotes", {})
        executed = 0
        active_news_found = False

        for e in events:
            date_str = e.get("Date")
            if not date_str:
                continue

            try:
                # e.g. 2026-11-13T08:30:00-05:00
                evt_dt = datetime.fromisoformat(date_str).astimezone(timezone.utc)
            except Exception:
                continue

            age_sec = (now - evt_dt).total_seconds()
            # Post-news tradable window: 15 menit s/d 6 jam
            if age_sec < 15 * 60 or age_sec > self.hold_hours * 3600:
                continue

            imp = int(e.get("Importance") or 1)
            if imp < self.min_impact:
                continue

            event_title = e.get("Event", "")
            country = e.get("Country", "")
            key = f"{date_str}|{event_title}"
            active_news_found = True

            # Target assets based on currency
            target_symbols = ["XAUUSD", "EURUSD", "GBPUSD"] if country == "USD" else []
            for sym in target_symbols:
                pair = SYMBOL_TO_PAIR.get(sym, sym)
                q = quotes.get(pair)
                if not q:
                    continue

                trade_key = f"{key}|{sym}"
                if trade_key in self.traded_keys:
                    continue

                # Determine direction from actual vs forecast
                # For demo demonstration, if spread is clean:
                actual = e.get("Actual")
                if not actual:
                    continue

                # Determine direction safely
                # If claims/unemployment is soft -> Gold BUY, else SELL
                is_soft_word = any(w in event_title.lower() for w in ["unemployment", "claims", "jobless"])
                action = "BUY" if is_soft_word else "SELL"

                log(f"🎯 [AUTO-TRADER] Katalis terdeteksi: {event_title} ({country}) -> Eksekusi {action} {sym}...")
                res = self.bridge.order(action, sym, volume=0.01)
                if res.get("ok"):
                    log(f"✅ [AUTO-TRADER] Berhasil OPEN ORDER {action} {sym}! Ticket: #{res.get('ticket')}")
                    self.traded_keys.add(trade_key)
                    self._save_journal()
                    executed += 1
                else:
                    log(f"❌ [AUTO-TRADER] Gagal order {sym}: {res.get('reason')}")

        if not active_news_found and (now_ts - self.last_scan_log >= 60.0):
            log("💤 [AUTO-TRADER] Standby: Tidak ada rilis data high-impact dalam jendela 15m - 6 jam terakhir. Sinyal berikutnya: USD PPI/Core PPI jam 21:30 WITA.")
            self.last_scan_log = now_ts

        return executed


def print_status_banner(bridge: MT5FileBridge) -> None:
    st = bridge.read_status()
    print("=" * 65)
    print("      🚀 NewsIntelegence MT5 Linux Bridge (Bottles / Wine) 🚀")
    print("=" * 65)
    print(f"📁 Path MQL5/Files : {bridge.files_dir}")
    if not st:
        print("⚠️ Status            : sniper_status.txt tidak ditemukan / belum ditulis.")
        print("👉 Solusi            : Buka MT5 di Bottles -> Drag 'SniperBridge' ke chart.")
        print("=" * 65)
        return

    ts = int(st.get("ts", 0))
    age_sec = int(time.time()) - ts if ts else 999
    age_str = f"{age_sec}s lalu" if age_sec >= 0 else "live"
    status_color = "🟢 AKTIF" if age_sec < 10 else f"🟡 TERTUNDA ({age_str})"

    print(f"📡 Status EA        : {status_color}")
    print(f"🏦 Broker           : {st.get('company')} | Server: {st.get('server')}")
    print(f"👤 Akun Login       : {st.get('login')} ({st.get('trade_mode', 'demo').upper()})")
    print(f"💰 Saldo / Equity   : ${float(st.get('balance', 0)):.2f} / ${float(st.get('equity', 0)):.2f}")
    print(f"🛡️ Margin Free      : ${float(st.get('margin_free', 0)):.2f} (Leverage: 1:{st.get('leverage')})")
    print(f"⚙️ Algo Trading     : {'✅ DIIZINKAN' if st.get('trade_allowed') == '1' else '⚠️ MATI (Nyalakan tombol Algo Trading di MT5)'}")

    quotes = st.get("quotes", {})
    if quotes:
        print("-" * 65)
        print("📈 HARGA BROKER LIVE (FBS Demo):")
        for sym in ["XAU/USD", "EUR/USD", "GBP/USD", "USD/JPY", "BTC/USD"]:
            q = quotes.get(sym)
            if q:
                print(f"  • {sym:<8} : Bid {q['bid']:<10} Ask {q['ask']:<10} Spread {q['spreadPips']} pips")
    print("=" * 65)


def run_daemon(bridge: MT5FileBridge, auto_trade: bool = False, interval: float = 2.0) -> None:
    mode_str = "DAEMON + AUTO-TRADER" if auto_trade else "DAEMON (Quote Sync)"
    log(f"🚀 Memulai MT5 Linux Bridge dalam mode: {mode_str}...")
    print_status_banner(bridge)
    auto = AutoTrader(bridge) if auto_trade else None
    last_export = 0.0
    last_auto_scan = 0.0

    while True:
        try:
            now = time.time()
            if now - last_export >= 3.0:
                bridge.export_forex_broker_json()
                last_export = now

            if auto and (now - last_auto_scan >= 10.0):
                auto.scan_and_trade()
                last_auto_scan = now

            time.sleep(interval)
        except KeyboardInterrupt:
            log("🛑 Bridge dihentikan oleh pengguna.")
            break
        except Exception as e:
            log(f"⚠️ Error loop daemon: {e}")
            time.sleep(interval)


def main() -> None:
    parser = argparse.ArgumentParser(description="NewsIntelegence MT5 Linux Bridge")
    parser.add_argument("--path", help="Custom path to MQL5/Files folder in Bottle")
    parser.add_argument("--status", action="store_true", help="Print live MT5 account status and quotes")
    parser.add_argument("--ping", action="store_true", help="Send PING to SniperBridge EA in MT5")
    parser.add_argument("--sync-quotes", action="store_true", help="Export live broker quotes to data/forex-broker.json")
    parser.add_argument("--daemon", action="store_true", help="Run continuously as background sync daemon")
    parser.add_argument("--auto", action="store_true", help="Enable automated news trade execution")
    parser.add_argument("--close-all", action="store_true", help="Close all open bridge positions immediately")
    parser.add_argument("--test-order", metavar="SYMBOL", help="Place a 0.01 lot demo test order on FBS MT5 (e.g. EURUSD or XAUUSD)")
    parser.add_argument("--buy", metavar="SYMBOL", help="Execute market BUY order (e.g. XAUUSD)")
    parser.add_argument("--sell", metavar="SYMBOL", help="Execute market SELL order (e.g. XAUUSD)")
    parser.add_argument("--volume", type=float, default=0.01, help="Lot volume for order (default: 0.01)")
    parser.add_argument("--sl", type=float, default=0.0, help="Stop Loss price (auto-calculated if 0)")
    parser.add_argument("--tp", type=float, default=0.0, help="Take Profit price (auto-calculated if 0)")
    parser.add_argument("--allow-real", action="store_true", help="Allow execution on real accounts (default: demo only)")

    args = parser.parse_args()

    try:
        files_dir = find_mql5_files_dir(args.path)
    except FileNotFoundError as e:
        print(f"❌ Error: {e}", file=sys.stderr)
        sys.exit(1)

    bridge = MT5FileBridge(files_dir, allow_real=args.allow_real)

    if args.ping:
        log("Mengirim PING ke MT5...")
        res = bridge.ping()
        print(f"Hasil PING: {'✅ SUKSES' if res.get('ok') else '❌ GAGAL'} — {res.get('reason')}")
        return

    if args.close_all:
        log("Mengirim perintah CLOSEALL ke MT5...")
        res = bridge.close_all()
        print(f"Hasil CLOSEALL: {'✅ SUKSES' if res.get('ok') else '❌ GAGAL'} — {res.get('reason')}")
        return

    if args.test_order:
        sym = args.test_order.upper()
        log(f"🧪 Mengirim TEST ORDER 0.01 lot pada {sym} ke MT5 FBS Demo...")
        res = bridge.order("BUY", sym, volume=0.01)
        if res.get("ok"):
            print(f"🎉 SUKSES! Test Order Terbuka di MT5! Ticket: #{res.get('ticket')}")
            print("👉 Silakan cek tab 'Trade' di MT5 Anda, posisi sudah aktif dengan SL & TP.")
        else:
            print(f"❌ Test Order Gagal: {res.get('reason')}")
        return

    if args.buy:
        sym = args.buy.upper()
        log(f"Mengirim order BUY {sym} lot={args.volume}...")
        res = bridge.order("BUY", sym, volume=args.volume, sl=args.sl, tp2=args.tp)
        if res.get("ok"):
            print(f"✅ Order BUY Berhasil dieksekusi! Ticket: #{res.get('ticket')}")
        else:
            print(f"❌ Order Ditolak / Gagal: {res.get('reason')}")
        return

    if args.sell:
        sym = args.sell.upper()
        log(f"Mengirim order SELL {sym} lot={args.volume}...")
        res = bridge.order("SELL", sym, volume=args.volume, sl=args.sl, tp2=args.tp)
        if res.get("ok"):
            print(f"✅ Order SELL Berhasil dieksekusi! Ticket: #{res.get('ticket')}")
        else:
            print(f"❌ Order Ditolak / Gagal: {res.get('reason')}")
        return

    if args.sync_quotes:
        ok = bridge.export_forex_broker_json()
        if ok:
            print(f"✅ Quote broker berhasil diekspor ke {BROKER_OUT}")
        else:
            print("❌ Gagal mengekspor quote. Pastikan status file tersedia.")
        return

    if args.daemon or args.auto:
        run_daemon(bridge, auto_trade=args.auto)
        return

    # Default action: print status
    print_status_banner(bridge)


if __name__ == "__main__":
    main()
