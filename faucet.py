# faucet.py
import os, re, time, sys, traceback
from flask import Blueprint, request, jsonify
from stellar_sdk import Server, Keypair, TransactionBuilder, Asset

bp_faucet = Blueprint("faucet", __name__)

# -------- Config --------
HORIZON = os.environ.get("PI_TESTNET_HORIZON", "https://api.testnet.minepi.com")
NETWORK = "Pi Testnet"
FAUCET_SECRET = os.environ["FAUCET_SECRET"]                     # Distributor SECRET (S…)
STARTING_BAL = str(os.environ.get("FAUCET_STARTING_BALANCE", "2"))  # 2 native by default

server = Server(HORIZON)

# -------- tiny per-IP rate limit --------
_last = {}
def rate_limited(ip, window=60, max_hits=6):
    now = time.time()
    t, c = _last.get(ip, (0, 0))
    if now - t > window:
        _last[ip] = (now, 1)
        return False
    c += 1
    _last[ip] = (t, c)
    return c > max_hits

def _extract_result_codes(err):
    """
    Try to pull Horizon result codes off a python-stellar-sdk exception,
    regardless of version (extras/problem shapes vary slightly).
    """
    try:
        # Newer SDKs often stash detail in err.extras or err.problem
        if hasattr(err, "extras") and isinstance(err.extras, dict):
            ex = err.extras
        elif hasattr(err, "problem") and isinstance(err.problem, dict):
            ex = err.problem.get("extras") or err.problem
        else:
            ex = {}
        if isinstance(ex, dict):
            if "result_codes" in ex:
                return ex["result_codes"]
            # Sometimes nested under extras.result_codes
            rc = ex.get("extras", {}).get("result_codes")
            if rc:
                return rc
    except Exception:
        pass
    return None

# -------- health / self-test --------
@bp_faucet.get("/faucet/selftest")
def faucet_selftest():
    try:
        source = Keypair.from_secret(FAUCET_SECRET)
        acct = server.accounts().account_id(source.public_key).call()
        native = next((b["balance"] for b in acct.get("balances", []) if b.get("asset_type") == "native"), "0")
        return jsonify({
            "ok": True,
            "network": NETWORK,
            "horizon": HORIZON,
            "source_public": source.public_key,
            "native_balance": native,
            "starting_balance": STARTING_BAL
        })
    except Exception as e:
        return jsonify({"ok": False, "err": str(e)}), 500

# -------- main faucet --------
@bp_faucet.post("/faucet")
def faucet():
    ip = (request.headers.get("X-Forwarded-For") or request.remote_addr or "").split(",")[0].strip()
    if rate_limited(ip):
        return jsonify({"ok": False, "err": "rate-limit"}), 429

    dest = ((request.get_json(silent=True) or {}).get("dest") or "").strip().upper()
    if not re.match(r"^G[A-Z0-9]{55}$", dest):
        return jsonify({"ok": False, "err": "bad-dest"}), 400

    # Load source (distributor) key and account
    try:
        source = Keypair.from_secret(FAUCET_SECRET)
    except Exception as e:
        return jsonify({"ok": False, "err": f"bad-source:{e}"}), 500

    try:
        src_acct = server.load_account(source.public_key)
    except Exception as e:
        return jsonify({"ok": False, "err": f"load-source:{e}"}), 500

    # Decide whether to CreateAccount or just pay native (idempotent UX)
    need_create = False
    try:
        server.accounts().account_id(dest).call()
        need_create = False  # exists → top-up with native
    except Exception:
        need_create = True   # not found → create with starting balance

    try:
        base_fee = server.fetch_base_fee()
        tb = TransactionBuilder(src_acct, network_passphrase=NETWORK, base_fee=base_fee)
        if need_create:
            tb.append_create_account_op(destination=dest, starting_balance=str(STARTING_BAL))
        else:
            tb.append_payment_op(destination=dest, amount=str(STARTING_BAL), asset=Asset.native())

        tx = tb.set_timeout(180).build()
        tx.sign(source)
        res = server.submit_transaction(tx)
        return jsonify({"ok": True, "hash": res.get("hash"), "created": need_create})
    except Exception as e:
        codes = _extract_result_codes(e)
        if codes:
            return jsonify({"ok": False, "err": "horizon", "codes": codes}), 500
        # Fallback: log stack & return stringified error
        print("FAUCET ERROR:", repr(e), file=sys.stderr)
        traceback.print_exc()
        return jsonify({"ok": False, "err": str(e)}), 500
