"""
alert_logger.py — append every triggered alert to a daily log file
inside logs/. Folder and file are created automatically. Append-only.
"""
import os
from datetime import datetime

LOGS_DIR = os.path.join(os.getcwd(), "logs")


def log_alert(message: str) -> bool:
    """
    Append `message` to logs/alerts_YYYY-MM-DD.log.
    Never raises — failures are printed and swallowed.
    """
    try:
        os.makedirs(LOGS_DIR, exist_ok=True)
        fname = f"alerts_{datetime.now().strftime('%Y-%m-%d')}.log"
        fpath = os.path.join(LOGS_DIR, fname)
        with open(fpath, "a", encoding="utf-8") as f:
            f.write(f"[{datetime.now().isoformat()}]\n{message}\n{'-'*60}\n")
        return True
    except Exception as exc:
        print(f"Alert log write failed: {exc}")
        return False