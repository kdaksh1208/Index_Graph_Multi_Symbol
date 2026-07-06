"""
telegram_alert.py — minimal helper to send a Telegram alert message.
Added for Telegram integration only. Does not touch any alert logic.
"""
import requests
from config import BOT_TOKEN, CHAT_ID

TELEGRAM_API_URL = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"


def send_telegram_alert(message: str) -> bool:
    """
    Send `message` to the configured Telegram chat.
    Never raises — failures are printed and swallowed so the tracker
    keeps running even if Telegram is unreachable or misconfigured.
    """
    if not BOT_TOKEN or not CHAT_ID:
        print("Telegram alert failed: BOT_TOKEN/CHAT_ID not configured in config.py")
        return False
    try:
        resp = requests.post(
            TELEGRAM_API_URL,
            data={"chat_id": CHAT_ID, "text": message},
            timeout=10,
        )
        if resp.status_code != 200:
            print(f"Telegram alert failed: HTTP {resp.status_code} — {resp.text}")
            return False
        return True
    except Exception as exc:
        print(f"Telegram alert failed: {exc}")
        return False