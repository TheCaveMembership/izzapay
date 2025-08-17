import os, time
from decimal import Decimal
import requests

PI_API = os.getenv("PI_PLATFORM_API_URL", "https://api.minepi.com")
PI_KEY = os.getenv("PI_PLATFORM_API_KEY", "")
PLATFORM_WALLET = os.getenv("PLATFORM_PI_WALLET", "@yourplatform")
APP_FEE_RATE = Decimal(os.getenv("APP_FEE_RATE", "0.01"))

def split_amounts(gross_pi: float):
    gross = Decimal(str(gross_pi))
    fee = (gross * APP_FEE_RATE).quantize(Decimal("0.0001"))
    net = (gross - fee).quantize(Decimal("0.0001"))
    return gross, fee, net

def verify_pi_tx(tx_hash: str, expected_amount: Decimal) -> bool:
    """
    TODO: Replace with real Pi Platform call to confirm status+amount.
    """
    # headers = {"Authorization": f"Key {PI_KEY}"}
    # r = requests.get(f"{PI_API}/payments/{tx_hash}", headers=headers, timeout=12)
    # data = r.json()
    # return data["status"] == "confirmed" and Decimal(data["amount"]) == expected_amount
    time.sleep(0.2)
    return True

def send_pi_payout(to_wallet: str, amount: Decimal, memo: str) -> bool:
    """
    TODO: Replace with Pi transfer from your platform wallet.
    """
    # headers = {"Authorization": f"Key {PI_KEY}"}
    # payload = {"to": to_wallet, "amount": str(amount), "memo": memo}
    # r = requests.post(f"{PI_API}/transfers", json=payload, headers=headers, timeout=12)
    # return r.ok
    time.sleep(0.2)
    return True
