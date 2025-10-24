# faucet.py
import os, re, time
from flask import Blueprint, request, jsonify
from stellar_sdk import Server, Keypair, TransactionBuilder

bp_faucet = Blueprint("faucet", __name__)

HORIZON = os.environ.get("PI_TESTNET_HORIZON", "https://api.testnet.minepi.com")
NETWORK = "Pi Testnet"
FAUCET_SECRET = os.environ["FAUCET_SECRET"]               # <-- set to Distributor SECRET (S…)
STARTING_BAL = os.environ.get("FAUCET_STARTING_BALANCE", "2")  # send 2 Test-Pi

server = Server(HORIZON)

# tiny per-IP rate limit
_last = {}
def rate_limited(ip, window=60, max_hits=6):
    now = time.time()
    t,c = _last.get(ip, (0,0))
    if now - t > window: _last[ip] = (now, 1); return False
    c += 1; _last[ip] = (t, c); return c > max_hits

@bp_faucet.post("/faucet")
def faucet():
    ip = (request.headers.get("X-Forwarded-For") or request.remote_addr or "").split(",")[0].strip()
    if rate_limited(ip): return jsonify({"ok": False, "err": "rate-limit"}), 429

    dest = ((request.json or {}).get("dest") or "").strip().upper()
    if not re.match(r"^G[A-Z0-9]{55}$", dest):
        return jsonify({"ok": False, "err": "bad-dest"}), 400

    # If it already exists, say ok (idempotent UX)
    try:
        server.accounts().account_id(dest).call()
        return jsonify({"ok": True, "already": True})
    except Exception:
        pass

    try:
        source = Keypair.from_secret(FAUCET_SECRET)
        src_acct = server.load_account(source.public_key)

        tx = (TransactionBuilder(src_acct, network_passphrase=NETWORK, base_fee=server.fetch_base_fee())
              .append_create_account_op(destination=dest, starting_balance=str(STARTING_BAL))
              .set_timeout(180).build())
        tx.sign(source)
        res = server.submit_transaction(tx)
        return jsonify({"ok": True, "hash": res.get("hash")})
    except Exception as e:
        return jsonify({"ok": False, "err": str(e)}), 500
