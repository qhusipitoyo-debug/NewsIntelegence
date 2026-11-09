"""Pure math and guard helpers for the forex breakout-grid executor.

No MetaTrader5 import here so the logic is unit-testable anywhere.
"""

import math
import re
from datetime import timedelta


def pip_size(digits, point):
    return point * 10 if digits in (3, 5) else point


def grid_index(price, step):
    return math.floor(price / step + 1e-9)


def grid_level(index, step):
    return index * step


def round_price(price, digits):
    return round(price, digits)


def sl_tp(entry, direction, sl_pips, tp_pips, pip):
    sign = 1 if direction == "long" else -1
    return entry - sign * sl_pips * pip, entry + sign * tp_pips * pip


def risk_usd(entry, sl, contract_size, lot, quote_to_usd=1.0):
    return abs(entry - sl) * contract_size * lot * quote_to_usd


def be_price(entry, direction, spread_pips, buffer_pips, pip, digits):
    sign = 1 if direction == "long" else -1
    return round_price(entry + sign * (spread_pips + buffer_pips) * pip, digits)


def should_breakeven(direction, entry, current_price, trigger_pips, pip):
    if direction == "long":
        return current_price >= entry + trigger_pips * pip
    return current_price <= entry - trigger_pips * pip


def should_breakeven_dist(direction, entry, current_price, distance):
    if direction == "long":
        return current_price >= entry + distance
    return current_price <= entry - distance


def within_chase(price, level, max_pips, pip):
    return abs(price - level) <= max_pips * pip + 1e-12


def in_session(now, friday_close_hour=16):
    if now.weekday() >= 5:
        return False
    if now.weekday() == 4:
        return 7 <= now.hour < friday_close_hour
    return 7 <= now.hour < 19


def news_blackout(events, currencies, now, window_minutes=30):
    lo = now - timedelta(minutes=window_minutes)
    hi = now + timedelta(minutes=window_minutes)
    wanted = {str(c).upper() for c in currencies}
    for ev in events or []:
        dt = ev.get("dt")
        if dt is None or not lo <= dt <= hi:
            continue
        if int(ev.get("importance") or 0) < 2:
            continue
        if str(ev.get("currency") or "").upper() not in wanted:
            continue
        return ev.get("name") or "news"
    return None


def news_volatility(events, currencies, now, window_minutes=60, min_importance=3):
    lo = now - timedelta(minutes=window_minutes)
    wanted = {str(c).upper() for c in currencies}
    for ev in events or []:
        dt = ev.get("dt")
        if dt is None or not lo <= dt <= now:
            continue
        if int(ev.get("importance") or 0) < min_importance:
            continue
        if str(ev.get("currency") or "").upper() not in wanted:
            continue
        return ev.get("name") or "news"
    return None


def guard_tripped(day, equity, max_loss):
    return equity <= float(day.get("start_equity", equity)) - float(max_loss)


def summarize_trades(trades):
    """Ringkasan statistik closed-trade: win rate, profit factor, expectancy.

    `trades` adalah daftar dict penutupan (PAPER_CLOSE / sync) dengan field
    numerik `pnl` (USD, sudah dikonversi ke USD). Trade yang masih open
    (tanpa pnl) tidak boleh masuk ke agregasi ini.
    """
    closed = [t for t in (trades or []) if t.get("pnl") is not None]
    total = len(closed)
    wins = [t for t in closed if float(t.get("pnl") or 0) > 0]
    losses = [t for t in closed if float(t.get("pnl") or 0) <= 0]
    win_rate = (len(wins) / total) if total else 0.0
    gross_win = sum(float(t.get("pnl") or 0) for t in wins)
    gross_loss = abs(sum(float(t.get("pnl") or 0) for t in losses))
    profit_factor = (gross_win / gross_loss) if gross_loss > 0 else None
    avg_win = (gross_win / len(wins)) if wins else 0.0
    avg_loss = (gross_loss / len(losses)) if losses else 0.0
    expectancy = ((win_rate * avg_win) - ((1 - win_rate) * avg_loss)) if total else 0.0
    return {
        "total": total,
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": win_rate,
        "profit_factor": profit_factor,
        "gross_win": gross_win,
        "gross_loss": gross_loss,
        "net_pnl": gross_win - gross_loss,
        "avg_win": avg_win,
        "avg_loss": avg_loss,
        "expectancy": expectancy,
    }


def summarize_trades_by_pair(trades):
    """Ringkasan closed-trade per pair, untuk dashboard: semua pair yang punya closed trade."""
    grouped = {}
    for t in trades or []:
        if t.get("pnl") is None:
            continue
        grouped.setdefault(str(t.get("pair") or "UNKNOWN"), []).append(t)
    out = []
    for key in sorted(grouped):
        stats = summarize_trades(grouped[key])
        stats["pair"] = key
        out.append(stats)
    return out


def trades_from_order_rows(rows):
    """Closed-trade dari baris order CSV (event PAPER_CLOSE + pnl di note).

    Dipakai untuk *seed* statistik win rate dari `bridge/grid_orders.csv` tanpa
    harus menunggu runtime MT5, supaya agregasi statistik tidak hanya bergantung
    pada state yang dimuat dari file JSON.
    """
    trades = []
    for r in rows or []:
        if str(r.get("event") or "") not in ("PAPER_CLOSE", "CLOSE"):
            continue
        note = str(r.get("note") or "")
        m = re.search(r"pnl=\$(-?[\d]*\.?\d+)", note)
        pnl = float(m.group(1)) if m else None
        if pnl is None:
            continue
        def num(key):
            raw = str(r.get(key) or "").strip()
            return float(raw) if raw and float(raw) > 0 else None
        trades.append({
            "pair": r.get("pair") or "",
            "dir": r.get("dir") or "",
            "lot": num("lot"),
            "entry": None,
            "sl": num("sl"),
            "tp": num("tp"),
            "exit": num("price"),
            "pnl": pnl,
            "reason": r.get("status") or "",
        })
    return trades
