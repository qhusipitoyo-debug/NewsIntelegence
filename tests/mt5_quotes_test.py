#!/usr/bin/env python3
"""Offline tests for the local MT5 quote exporter (no MetaTrader5 required)."""

from __future__ import annotations

import importlib.util
import json
import contextlib
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("mt5_quotes", ROOT / "scripts" / "mt5_quotes.py")
mt5_quotes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mt5_quotes)

PAIRS = {
    "EUR/USD": (1.12000, 1.12009),
    "GBP/USD": (1.34000, 1.34012),
    "USD/JPY": (158.400, 158.418),
    "USD/CHF": (0.81800, 0.81809),
    "AUD/USD": (0.69600, 0.69610),
    "USD/CAD": (1.39900, 1.39911),
    "NZD/USD": (0.56000, 0.56011),
    "GBP/JPY": (212.700, 212.716),
    "EUR/JPY": (177.600, 177.614),
    "XAU/USD": (4142.20, 4142.55),
}


class FakeInfo:
    def __init__(self, name, digits):
        self.name = name
        self.digits = digits
        self.visible = True


class FakeTick:
    def __init__(self, bid, ask, stamp):
        self.bid = bid
        self.ask = ask
        self.time = stamp


class FakeMT5:
    """Suffix-style symbols plus sensitive account fields that must not leak."""

    def __init__(self):
        self.infos = {}
        self.ticks = {}
        for pair, (bid, ask) in PAIRS.items():
            name = pair.replace("/", "") + ".r"
            digits = 2 if pair.startswith("XAU") else (3 if pair.endswith("JPY") else 5)
            self.infos[name] = FakeInfo(name, digits)
            self.ticks[name] = FakeTick(bid, ask, 1793760430)

    def symbol_info(self, name):
        return self.infos.get(name)

    def symbols_get(self):
        return list(self.infos.values())

    def symbol_select(self, name, enable):
        return True

    def symbol_info_tick(self, name):
        return self.ticks.get(name)

    def account_info(self):
        return SimpleNamespace(
            company="FBS Markets Inc.",
            server="FBS-Demo",
            trade_mode=0,
            login=12345678,
            balance=5000.25,
            equity=5001.75,
        )

    def terminal_info(self):
        return SimpleNamespace(name="MetaTrader 5 EXNESS")


def test_pure_helpers():
    assert mt5_quotes.pip_size("EUR/USD", 5) == 0.0001
    assert mt5_quotes.pip_size("USD/JPY", 3) == 0.01
    assert mt5_quotes.pip_size("GBP/JPY", 3) == 0.01
    assert mt5_quotes.pip_size("XAU/USD", 2) == 0.01
    assert mt5_quotes.pip_size("XAU/USD", None) == 0.01
    assert mt5_quotes.broker_id("FBS Markets Inc.", "FBS-Demo") == "FBS"
    assert mt5_quotes.broker_id("GO Markets Pty Ltd", "GO-Markets-Live") == "GOMARKETS"
    assert mt5_quotes.broker_id("CMC Markets", "CMC-Live") == "CMCMARKETS"
    assert mt5_quotes.account_type(0) == "demo"
    assert mt5_quotes.account_type(1) == "contest"
    assert mt5_quotes.account_type(2) == "real"
    assert mt5_quotes.account_type(None) == "unknown"


def test_payload_shape_and_no_credentials():
    mt5 = FakeMT5()
    now = datetime(2026, 11, 4, 0, 50, tzinfo=timezone.utc)
    payload = mt5_quotes.build_payload(mt5, now)

    assert payload["source"] == "MT5 local bridge"
    broker = payload["broker"]
    assert broker["id"] == "FBS"
    assert broker["name"] == "FBS"
    assert broker["accountType"] == "demo"
    assert set(broker) == {"id", "name", "accountType"}, "public broker payload must stay minimal"
    assert payload["providers"]["FBS"]["status"] == "ok"
    assert len(payload["quotes"]) == 10

    gold = payload["quotes"]["XAU/USD"]
    assert gold["symbol"] == "XAUUSD.r", "gold must be bridged from the broker"
    assert gold["bid"] == 4142.2
    assert gold["ask"] == 4142.55
    assert gold["spreadPips"] == 35.0
    assert gold["digits"] == 2

    eur = payload["quotes"]["EUR/USD"]
    assert eur["symbol"] == "EURUSD.r", "suffix symbols must resolve"
    assert eur["bid"] == 1.12
    assert eur["ask"] == 1.12009
    assert eur["spreadPips"] == 0.9
    assert eur["digits"] == 5
    assert "brokerTime" in eur and "tickTime" not in eur

    jpy = payload["quotes"]["USD/JPY"]
    assert jpy["digits"] == 3
    assert jpy["spreadPips"] == 1.8

    serialized = json.dumps(payload)
    for secret in ("12345678", "5000.25", "5001.75", "login", "balance", "equity", "password",
                   "FBS-Demo", "MetaTrader 5 EXNESS", "FBS Markets Inc."):
        assert secret not in serialized, f"sensitive field leaked: {secret}"


def test_atomic_json_write():
    payload = {"broker": {"id": "FBS"}, "quotes": {"EUR/USD": {"bid": 1.1, "ask": 1.1001}}}
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "forex-broker.json"
        mt5_quotes.write_json(out, payload)
        assert json.loads(out.read_text(encoding="utf-8")) == payload
        assert not list(Path(tmp).glob("*.tmp")), "temp file must be cleaned up"


def test_missing_quotes_raises():
    mt5 = FakeMT5()
    mt5.ticks = {}
    try:
        with open(os.devnull, "w", encoding="utf-8") as devnull:
            with contextlib.redirect_stderr(devnull):
                mt5_quotes.build_payload(mt5)
    except RuntimeError as exc:
        assert "no tradable forex quotes" in str(exc)
    else:
        raise AssertionError("empty quotes must fail instead of overwriting good data")


def main() -> int:
    tests = [
        test_pure_helpers,
        test_payload_shape_and_no_credentials,
        test_atomic_json_write,
        test_missing_quotes_raises,
    ]
    for test in tests:
        test()
        print(f"ok {test.__name__}")
    print(f"Passed {len(tests)} MT5 quote exporter tests")
    return 0


if __name__ == "__main__":
    sys.exit(main())
