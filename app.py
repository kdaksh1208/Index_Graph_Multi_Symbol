"""
NSE OI Tracker — Dynamic Multi-Symbol Backend
- Scrapes available symbols from NSE on startup (non-blocking)
- Exposes /api/available-symbols for the picker UI
- User POSTs /api/start-analysis with chosen symbols
- Independent per-symbol data loops start; all existing logic unchanged
"""

import os
import time
import threading
import webbrowser
import logging
import glob
import signal
import atexit
from datetime import datetime
from telegram_alert import send_telegram_alert
from alert_logger import log_alert

import pandas as pd
from flask import Flask, jsonify, render_template, request
from flask_cors import CORS
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.common.action_chains import ActionChains
from webdriver_manager.chrome import ChromeDriverManager
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("oi_tracker")

app = Flask(__name__)
CORS(app)

# ── Known index symbols (from NSE HTML equity_optionchain_select) ─────────────
NSE_INDEX_SYMBOLS = ["NIFTY", "NIFTYNXT50", "FINNIFTY", "BANKNIFTY", "MIDCPNIFTY"]

# ── Available symbols cache ───────────────────────────────────────────────────
available_symbols = {
    "indices": list(NSE_INDEX_SYMBOLS),
    "stocks":  [],
    "fetched": False,
    "error":   None,
}
_symbols_lock = threading.Lock()

# ── Analysis state ────────────────────────────────────────────────────────────
active_symbols:   list = []
symbol_data:      dict = {}
analysis_started: bool = False

_state_lock    = threading.Lock()
shutdown_event = threading.Event()
_active_driver = None
_driver_lock   = threading.Lock()


# ── Exceptions ────────────────────────────────────────────────────────────────
class ShutdownRequested(Exception):
    pass


# ── Helpers ───────────────────────────────────────────────────────────────────
def _make_symbol_state(sym):
    return {
        "history": [],
        "previous_strike_history": {},
        "status": {
            "phase": f"Waiting to start {sym}…",
            "last_update": None,
            "fetching": False,
            "error": None,
            "cycle": 0,
            "data_changed": True,
        },
    }


def _set_status(sym, msg, *, fetching=None, error=..., cycle=None, data_changed=None):
    with _state_lock:
        st = symbol_data[sym]["status"]
        st["phase"] = msg
        st["last_update"] = datetime.now().isoformat()
        if fetching is not None:
            st["fetching"] = fetching
        if error is not ...:
            st["error"] = error
        if cycle is not None:
            st["cycle"] = cycle
        if data_changed is not None:
            st["data_changed"] = data_changed
    log.info("[%s] %s", sym, msg)


def _check_shutdown():
    if shutdown_event.is_set():
        raise ShutdownRequested()


def _interruptible_sleep(seconds, interval=0.5):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        remaining = deadline - time.monotonic()
        shutdown_event.wait(min(interval, max(remaining, 0)))
        _check_shutdown()


def _sleep_or_stop(seconds):
    return shutdown_event.wait(seconds)


# ── Chrome factory ────────────────────────────────────────────────────────────
def _make_driver(download_dir=None):
    opts = Options()
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_experimental_option("excludeSwitches", ["enable-automation"])
    opts.add_experimental_option("useAutomationExtension", False)
    opts.add_argument("--disable-popup-blocking")
    opts.add_argument("--start-maximized")
    opts.add_argument(
        "user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    )
    if download_dir:
        opts.add_experimental_option("prefs", {
            "download.default_directory": download_dir,
            "download.prompt_for_download": False,
            "profile.default_content_settings.popups": 0,
            "safebrowsing.enabled": True,
        })
    return webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=opts)


def _stop_driver():
    global _active_driver
    with _driver_lock:
        if _active_driver is not None:
            try:
                _active_driver.quit()
            except Exception:
                pass
            finally:
                _active_driver = None


def _handle_shutdown(signum, frame):
    log.info("Shutdown signal %s", signum)
    shutdown_event.set()
    _stop_driver()
    os._exit(0)


# ── Symbol Discovery ──────────────────────────────────────────────────────────
def _discover_symbols():
    """Scrape NSE option chain page for all available symbols."""
    log.info("Discovering symbols from NSE…")
    driver = None
    try:
        driver = _make_driver()
        driver.get("https://www.nseindia.com/option-chain")
        wait = WebDriverWait(driver, 30)
        time.sleep(5)

        indices = list(NSE_INDEX_SYMBOLS)
        stocks  = []

        # Read index symbols from equity_optionchain_select
        try:
            sel = wait.until(EC.presence_of_element_located((By.ID, "equity_optionchain_select")))
            for opt in sel.find_elements(By.TAG_NAME, "option"):
                v = opt.get_attribute("value").strip()
                if v and v not in ("", "Select") and v not in indices:
                    indices.append(v)
            log.info("Index symbols: %s", indices)
        except Exception as e:
            log.warning("Could not read index select: %s", e)

        # Read stock symbols from select_symbol
        try:
            sel = driver.find_element(By.ID, "select_symbol")
            for opt in sel.find_elements(By.TAG_NAME, "option"):
                v = opt.get_attribute("value").strip()
                if v and v not in ("", "Select"):
                    stocks.append(v)
            log.info("Stock symbols: %d found", len(stocks))
        except Exception as e:
            log.warning("Could not read stock select: %s", e)

        with _symbols_lock:
            available_symbols["indices"] = indices
            available_symbols["stocks"]  = stocks
            available_symbols["fetched"] = True
            available_symbols["error"]   = None

    except Exception as e:
        log.error("Symbol discovery failed: %s", e)
        with _symbols_lock:
            available_symbols["fetched"] = True
            available_symbols["error"]   = str(e)
    finally:
        if driver:
            try:
                driver.quit()
            except Exception:
                pass


# ── Fetch option chain CSV for any symbol ────────────────────────────────────
def _fetch_option_chain(sym):
    global _active_driver
    _check_shutdown()

    with _symbols_lock:
        is_index = sym in available_symbols["indices"]

    driver = None
    try:
        driver = _make_driver(download_dir=os.getcwd())
        with _driver_lock:
            _active_driver = driver

        _check_shutdown()
        _set_status(sym, f"🌐 Opening NSE for {sym}…", fetching=True)
        driver.get("https://www.nseindia.com/option-chain")
        wait = WebDriverWait(driver, 25)
        _interruptible_sleep(3)
        _check_shutdown()

        # Dismiss modal
        try:
            btns = driver.find_elements(By.XPATH, "//button[contains(@class,'close')]")
            if btns:
                driver.execute_script("arguments[0].click();", btns[0])
                _interruptible_sleep(1)
        except ShutdownRequested:
            raise
        except Exception:
            pass

        _check_shutdown()

        if is_index:
            # Select index (NIFTY is already default)
            if sym != "NIFTY":
                _set_status(sym, f"🔧 Selecting index {sym}…", fetching=True)
                try:
                    sel = wait.until(EC.presence_of_element_located((By.ID, "equity_optionchain_select")))
                    driver.execute_script(
                        "arguments[0].value=arguments[1]; arguments[0].dispatchEvent(new Event('change'));",
                        sel, sym)
                    _interruptible_sleep(4)
                    _check_shutdown()
                except ShutdownRequested:
                    raise
                except Exception as e:
                    log.warning("[%s] Index select failed: %s", sym, e)

            # Read CMP
            try:
                cmp_text = wait.until(
                    EC.presence_of_element_located((By.ID, "header-nifty-val"))
                ).text.replace(",", "").strip()
                if sym != "NIFTY":
                    try:
                        uv = driver.find_element(By.ID, "equity_underlyingVal")
                        raw = "".join(c for c in uv.text.replace(",", "") if c.isdigit() or c == ".")
                        if raw:
                            cmp_text = raw
                    except Exception:
                        pass
                cmp = float(cmp_text)
            except Exception as e:
                log.error("[%s] CMP read failed: %s", sym, e)
                return None, None
        else:
            # Select stock
            _set_status(sym, f"🔧 Selecting stock {sym}…", fetching=True)
            try:
                sel = wait.until(EC.presence_of_element_located((By.ID, "select_symbol")))
                driver.execute_script(
                    "arguments[0].value=arguments[1]; arguments[0].dispatchEvent(new Event('change'));",
                    sel, sym)
                _interruptible_sleep(4)
                _check_shutdown()
            except ShutdownRequested:
                raise
            except Exception as e:
                log.warning("[%s] Stock select failed: %s", sym, e)

            try:
                uv = wait.until(EC.presence_of_element_located((By.ID, "equity_underlyingVal")))
                raw = "".join(c for c in uv.text.replace(",", "") if c.isdigit() or c == ".")
                cmp = float(raw)
            except Exception as e:
                log.error("[%s] CMP read failed: %s", sym, e)
                return None, None

        log.info("[%s] CMP: %.2f", sym, cmp)

        # Download CSV
        dl_btn = wait.until(EC.presence_of_element_located((By.ID, "downloadOCTable")))
        _interruptible_sleep(2)
        _check_shutdown()

        before = set(glob.glob(os.path.join(os.getcwd(), "option-chain*.csv")))
        _set_status(sym, f"📥 Downloading CSV for {sym}…", fetching=True)
        try:
            driver.execute_script("arguments[0].click();", dl_btn)
        except Exception:
            ActionChains(driver).move_to_element(dl_btn).click().perform()

        csv_file = None
        t0 = time.monotonic()
        while time.monotonic() - t0 < 25:
            _check_shutdown()
            cands = [p for p in glob.glob(os.path.join(os.getcwd(), "option-chain*.csv"))
                     if p not in before]
            if cands:
                best = max(cands, key=os.path.getctime)
                if os.path.getsize(best) > 100:
                    csv_file = best
                    break
            shutdown_event.wait(0.5)

        if not csv_file:
            _set_status(sym, f"❌ No CSV for {sym}", fetching=False, error="CSV not detected")
            return None, None

        # Parse CSV
        _set_status(sym, f"📊 Parsing CSV for {sym}…", fetching=True)
        import csv as _csv
        rows = []
        with open(csv_file, "r", encoding="utf-8") as f:
            for row in _csv.reader(f):
                rows.append([c.strip() for c in row])

        if len(rows) < 10:
            return None, None

        hdr_idx = None
        for i, row in enumerate(rows):
            if any(c.upper() == "STRIKE" for c in row):
                hdr_idx = i
                break
        if hdr_idx is None:
            return None, None

        def _num(v):
            v = str(v).replace(",", "").replace('"', "").strip()
            if v in ("", "-", "NA", "N/A"):
                return 0.0
            try:
                return float(v)
            except ValueError:
                return 0.0

        data = []
        for row in rows[hdr_idx + 1:]:
            if len(row) <= 21:
                continue
            strike = _num(row[11])
            if strike <= 0:
                continue
            data.append({
                "Strike":      int(round(strike)),
                "Call_OI":     max(_num(row[1]),  0.0),
                "Call_Chg_OI": _num(row[2]),
                "Put_OI":      max(_num(row[21]), 0.0),
                "Put_Chg_OI":  _num(row[20]),
            })

        if not data:
            _set_status(sym, f"❌ Empty data for {sym}", fetching=False, error="Empty parse")
            return None, None

        try:
            os.remove(csv_file)
        except OSError:
            pass

        df = pd.DataFrame(data).sort_values("Strike").reset_index(drop=True)
        log.info("[%s] %d rows, strike %d–%d", sym, len(df), df["Strike"].min(), df["Strike"].max())
        return df, cmp

    except ShutdownRequested:
        log.info("[%s] Fetch aborted", sym)
        raise
    except KeyboardInterrupt:
        shutdown_event.set()
        raise ShutdownRequested()
    except Exception as e:
        _set_status(sym, f"❌ Fetch error: {e}", fetching=False, error=str(e))
        log.error("[%s] %s", sym, e)
        return None, None
    finally:
        if driver:
            try:
                driver.quit()
            except Exception:
                pass
        with _driver_lock:
            if _active_driver is driver:
                _active_driver = None


# ── Support / Resistance (unchanged) ─────────────────────────────────────────
def _find_sr(df, cmp):
    sup = sup_call = sup_put = None
    sup_cc = sup_pc = 0.0
    sz = df[df["Strike"] <= cmp]
    if not sz.empty:
        mp = sz["Put_OI"].max()
        c = sz[(sz["Put_OI"] >= 0.25 * mp) & (sz["Put_OI"] >= 2 * sz["Call_OI"]) & (sz["Put_OI"] > 0)]
        if not c.empty:
            r = c.iloc[-1]
            sup = int(r["Strike"]); sup_call = float(r["Call_OI"]); sup_put = float(r["Put_OI"])
            sup_cc = float(r["Call_Chg_OI"]); sup_pc = float(r["Put_Chg_OI"])

    res = res_call = res_put = None
    res_cc = res_pc = 0.0
    rz = df[df["Strike"] >= cmp]
    if not rz.empty:
        mc = rz["Call_OI"].max()
        c = rz[(rz["Call_OI"] >= 0.25 * mc) & (rz["Call_OI"] >= 2 * rz["Put_OI"]) & (rz["Call_OI"] > 0)]
        if not c.empty:
            r = c.iloc[0]
            res = int(r["Strike"]); res_call = float(r["Call_OI"]); res_put = float(r["Put_OI"])
            res_cc = float(r["Call_Chg_OI"]); res_pc = float(r["Put_Chg_OI"])

    return {
        "support": sup, "support_call_oi": sup_call or 0.0, "support_put_oi": sup_put or 0.0,
        "support_call_chg_oi": sup_cc, "support_put_chg_oi": sup_pc,
        "resistance": res, "resistance_call_oi": res_call or 0.0, "resistance_put_oi": res_put or 0.0,
        "resistance_call_chg_oi": res_cc, "resistance_put_chg_oi": res_pc,
    }


def _update_strike_history(sym, df):
    for _, row in df.iterrows():
        symbol_data[sym]["previous_strike_history"][int(row["Strike"])] = {
            "call_oi": float(row["Call_OI"]), "put_oi": float(row["Put_OI"]),
        }


def _compute_deltas(sym, sr):
    spd = scd = rpd = rcd = 0.0
    psh = symbol_data[sym]["previous_strike_history"]

    if sr["support"] is not None:
        prev = psh.get(int(sr["support"]))
        if prev:
            spd = sr["support_put_oi"]  - prev["put_oi"]
            scd = sr["support_call_oi"] - prev["call_oi"]
            log.info("[%s] Sup @%d PΔ=%+.0f CΔ=%+.0f", sym, sr["support"], spd, scd)

    if sr["resistance"] is not None:
        prev = psh.get(int(sr["resistance"]))
        if prev:
            rpd = sr["resistance_put_oi"]  - prev["put_oi"]
            rcd = sr["resistance_call_oi"] - prev["call_oi"]
            log.info("[%s] Res @%d PΔ=%+.0f CΔ=%+.0f", sym, sr["resistance"], rpd, rcd)

    changed = any([spd, scd, rpd, rcd])
    return spd, scd, rpd, rcd, changed


def _build_snapshot(ts, cmp, sr, spd, scd, rpd, rcd, *, is_baseline, data_changed):
    return {
        "timestamp": ts, "cmp": cmp,
        "support_strike":         int(sr["support"])    if sr["support"]    is not None else None,
        "support_call_oi":        sr["support_call_oi"],
        "support_put_oi":         sr["support_put_oi"],
        "support_call_chg_oi":    sr["support_call_chg_oi"],
        "support_put_chg_oi":     sr["support_put_chg_oi"],
        "support_call_delta":     scd, "support_put_delta": spd,
        "resistance_strike":      int(sr["resistance"]) if sr["resistance"] is not None else None,
        "resistance_call_oi":     sr["resistance_call_oi"],
        "resistance_put_oi":      sr["resistance_put_oi"],
        "resistance_call_chg_oi": sr["resistance_call_chg_oi"],
        "resistance_put_chg_oi":  sr["resistance_put_chg_oi"],
        "resistance_call_delta":  rcd, "resistance_put_delta": rpd,
        "is_baseline": is_baseline, "data_changed": data_changed,
    }


# ── Per-symbol data loop (unchanged logic) ───────────────────────────────────
def _data_loop_for_symbol(sym):
    if shutdown_event.is_set():
        return
    with _state_lock:
        cycle = symbol_data[sym]["status"]["cycle"] + 1

    try:
        _set_status(sym, f"📥 [Cycle {cycle}] Baseline for {sym}…", fetching=True, cycle=cycle)
        df, cmp = _fetch_option_chain(sym)
        if df is None:
            _set_status(sym, f"⚠️ {sym} first fetch failed — retry in 60s", fetching=False, error="Failed")
            if _sleep_or_stop(60):
                return
        else:
            sr = _find_sr(df, cmp)
            ts = datetime.now().strftime("%H:%M:%S")
            with _state_lock:
                symbol_data[sym]["history"].append(
                    _build_snapshot(ts, cmp, sr, 0, 0, 0, 0, is_baseline=True, data_changed=True))
            _update_strike_history(sym, df)
            _set_status(sym,
                f"✅ {sym} baseline {ts} | CMP {cmp:.2f} | Sup {sr['support']} | Res {sr['resistance']}",
                fetching=False, error=None, data_changed=True)
    except ShutdownRequested:
        _set_status(sym, "🛑 Stopped.", fetching=False)
        return
    except Exception as exc:
        log.exception("[%s] Initial fetch error", sym)
        _set_status(sym, f"❌ {exc}", fetching=False, error=str(exc))

    while True:
        if _sleep_or_stop(120):
            break
        if shutdown_event.is_set():
            break
        with _state_lock:
            cycle = symbol_data[sym]["status"]["cycle"] + 1
        try:
            _set_status(sym, f"📥 [Cycle {cycle}] Fetching {sym}…", fetching=True, cycle=cycle)
            df, cmp = _fetch_option_chain(sym)
            if df is None:
                _set_status(sym, f"⚠️ {sym} failed — retry 60s", fetching=False, error="Failed")
                if _sleep_or_stop(60):
                    break
                continue
            sr = _find_sr(df, cmp)
            ts = datetime.now().strftime("%H:%M:%S")
            spd, scd, rpd, rcd, changed = _compute_deltas(sym, sr)
            with _state_lock:
                symbol_data[sym]["history"].append(
                    _build_snapshot(ts, cmp, sr, spd, scd, rpd, rcd,
                                    is_baseline=False, data_changed=changed))
            _update_strike_history(sym, df)
            msg = (f"✅ {sym} {ts} | CMP {cmp:.2f} | Sup {sr['support']} PΔ={spd:+.0f} CΔ={scd:+.0f} | "
                   f"Res {sr['resistance']} PΔ={rpd:+.0f} CΔ={rcd:+.0f}"
                   if changed else f"⚠️ {sym} {ts} unchanged | CMP {cmp:.2f}")
            _set_status(sym, msg, fetching=False, error=None, data_changed=changed)
        except ShutdownRequested:
            _set_status(sym, "🛑 Stopped.", fetching=False)
            break
        except Exception as exc:
            log.exception("[%s] Loop error", sym)
            _set_status(sym, f"❌ {exc}", fetching=False, error=str(exc))


# ── Launch analysis ───────────────────────────────────────────────────────────
def _launch_analysis(symbols):
    global active_symbols, symbol_data, analysis_started
    with _state_lock:
        active_symbols   = list(symbols)
        symbol_data      = {s: _make_symbol_state(s) for s in symbols}
        analysis_started = True
    log.info("Analysis starting for: %s", symbols)
    for i, sym in enumerate(symbols):
        def _run(s=sym, d=i * 5):
            if d > 0 and _sleep_or_stop(d):
                return
            _data_loop_for_symbol(s)
        threading.Thread(target=_run, daemon=True, name=f"oi-{sym}").start()


# ── Series builder ────────────────────────────────────────────────────────────
def _build_series(snap):
    sup, res = [], []
    for i, c in enumerate(snap):
        sup.append({"timestamp": c["timestamp"], "cmp": c["cmp"],
                    "strike": c["support_strike"],
                    "put_delta": c["support_put_delta"], "call_delta": c["support_call_delta"],
                    "put_oi": c["support_put_oi"], "call_oi": c["support_call_oi"],
                    "put_chg_oi": c["support_put_chg_oi"], "call_chg_oi": c["support_call_chg_oi"],
                    "is_baseline": c.get("is_baseline", i == 0), "data_changed": c.get("data_changed", True)})
        res.append({"timestamp": c["timestamp"], "cmp": c["cmp"],
                    "strike": c["resistance_strike"],
                    "put_delta": c["resistance_put_delta"], "call_delta": c["resistance_call_delta"],
                    "put_oi": c["resistance_put_oi"], "call_oi": c["resistance_call_oi"],
                    "put_chg_oi": c["resistance_put_chg_oi"], "call_chg_oi": c["resistance_call_chg_oi"],
                    "is_baseline": c.get("is_baseline", i == 0), "data_changed": c.get("data_changed", True)})
    return sup, res


# ── REST API ──────────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/available-symbols")
def api_available_symbols():
    with _symbols_lock:
        return jsonify({
            "indices": available_symbols["indices"],
            "stocks":  available_symbols["stocks"],
            "fetched": available_symbols["fetched"],
            "error":   available_symbols["error"],
        })


@app.route("/api/start-analysis", methods=["POST"])
def api_start_analysis():
    global analysis_started
    if analysis_started:
        return jsonify({"error": "Analysis already running"}), 400
    body    = request.get_json(force=True, silent=True) or {}
    symbols = [s.upper() for s in body.get("symbols", []) if s]
    if not symbols:
        return jsonify({"error": "Provide non-empty 'symbols' list"}), 400
    threading.Thread(target=_launch_analysis, args=(symbols,), daemon=True).start()
    return jsonify({"started": True, "symbols": symbols})


@app.route("/api/analysis-state")
def api_analysis_state():
    return jsonify({"started": analysis_started, "symbols": active_symbols})


@app.route("/api/status")
def api_status():
    with _state_lock:
        return jsonify({sym: dict(symbol_data[sym]["status"]) for sym in active_symbols})


@app.route("/api/status/<sym>")
def api_status_sym(sym):
    sym = sym.upper()
    if sym not in active_symbols:
        return jsonify({"error": "Not active"}), 404
    with _state_lock:
        return jsonify(dict(symbol_data[sym]["status"]))


@app.route("/api/data/<sym>")
def api_data_sym(sym):
    sym = sym.upper()
    if sym not in active_symbols:
        return jsonify({"error": "Not active"}), 404
    with _state_lock:
        snap = list(symbol_data[sym]["history"])
        st   = dict(symbol_data[sym]["status"])
    sup, res = _build_series(snap)
    return jsonify({"symbol": sym, "support": sup, "resistance": res,
                    "status": st, "current": snap[-1] if snap else None, "history_len": len(snap)})


@app.route("/api/alert-notify", methods=["POST"])
def api_alert_notify():
    """
    Added for Telegram + log integration.
    Called by the frontend at the exact moment the existing popup
    alert (_showPopupAlert) fires. Does not evaluate, duplicate, or
    move any alert condition — it only delivers the already-decided
    alert message.
    Order: Telegram, then log file (popup already fired client-side).
    """
    body = request.get_json(force=True, silent=True) or {}
    message = body.get("message", "")
    if not message:
        return jsonify({"error": "Missing 'message'"}), 400

    send_telegram_alert(message)
    log_alert(message)

    return jsonify({"ok": True})


@app.route("/api/symbols")
def api_symbols():
    return jsonify({"symbols": active_symbols})


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    signal.signal(signal.SIGINT,  _handle_shutdown)
    signal.signal(signal.SIGTERM, _handle_shutdown)
    atexit.register(_stop_driver)

    threading.Thread(target=_discover_symbols, daemon=True, name="symbol-discovery").start()

    def _open():
        time.sleep(2.5)
        webbrowser.open("http://localhost:5000")
    threading.Thread(target=_open, daemon=True).start()

    log.info("NSE OI Tracker (Dynamic)  →  http://localhost:5000")
    app.run(host="0.0.0.0", port=5000, debug=False, use_reloader=False)