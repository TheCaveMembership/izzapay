import os
import math
import sys
import argparse
import random
import time
from decimal import Decimal
from dotenv import load_dotenv
from stellar_sdk import Server, Keypair, TransactionBuilder, Asset, StrKey
from stellar_sdk.exceptions import NotFoundError, BadRequestError

# Use the same DB as the IZZA app
import db as app_db

# Try to import AuthorizationFlag, but verify attributes exist
try:
    from stellar_sdk.operation.set_options import AuthorizationFlag
    if all(hasattr(AuthorizationFlag, n) for n in (
        "AUTH_REQUIRED_FLAG", "AUTH_REVOCABLE_FLAG", "AUTH_CLAWBACK_ENABLED_FLAG"
    )):
        USE_ENUM_FLAGS = True
    else:
        USE_ENUM_FLAGS = False
except ImportError:
    USE_ENUM_FLAGS = False

load_dotenv()

def getenv(name, default=None, required=False):
    v = os.environ.get(name, default)
    if v is None and required:
        raise RuntimeError(f"Missing required env var: {name}")
    return v.strip() if isinstance(v, str) else v

HORIZON_URL        = getenv("HORIZON_URL", required=True)
NETWORK_PASSPHRASE = getenv("NETWORK_PASSPHRASE", required=True)

ISSUER_PUB    = getenv("ISSUER_PUB", required=True)
ISSUER_SECRET = getenv("ISSUER_SECRET", required=True)
DISTR_PUB     = getenv("DISTR_PUB", required=True)
DISTR_SECRET  = getenv("DISTR_SECRET", required=True)

ASSET_CODE  = getenv("ASSET_CODE", "IZZA")
# Default mint is now 500,000 IZZA (you will set RUN_MINT=0 so this is idle for now)
MINT_AMOUNT = getenv("MINT_AMOUNT", "500000.0000000")
HOME_DOMAIN = getenv("HOME_DOMAIN", "izzapay.onrender.com")

FUNDING_SECRET       = getenv("FUNDING_SECRET", "")
FUNDING_STARTING_BAL = getenv("FUNDING_STARTING_BALANCE", "5")

# Optional manual override via env
BASE_FEE_OVERRIDE = getenv("BASE_FEE", "")

# Runtime switches
RUN_MINT          = getenv("RUN_MINT", "0") == "1"
RUN_SELL_LADDER   = getenv("RUN_SELL_LADDER", "0") == "1"
RUN_MOVE_IZZA     = getenv("RUN_MOVE_IZZA", "0") == "1"
RUN_NATIVE_PAYOUT = getenv("RUN_NATIVE_PAYOUT", "0") == "1"

# Weekly IZZA airdrop to all IZZA trustline holders
RUN_AIRDROP     = getenv("RUN_AIRDROP", "0") == "1"
AIRDROP_AMOUNT  = getenv("AIRDROP_AMOUNT", "0.0000001")
AIRDROP_TAG     = getenv("AIRDROP_TAG", "").strip()      # e.g. "IZZALOOT"

# TEMP single wallet test target
AIRDROP_SINGLE_DEST = getenv(
    "AIRDROP_SINGLE_DEST",
    "GDDFUCFIWEXARKUPKBU5SKXBQSUNTBPQQEDYHGYJGSZFYCGCGZO5X7CT"
).strip()

# Airdrop throttling and retry controls
AIRDROP_SLEEP_SECONDS = float(getenv("AIRDROP_SLEEP_SECONDS", "0.9"))
AIRDROP_MAX_RETRIES   = int(getenv("AIRDROP_MAX_RETRIES", "3"))

# Move IZZA configuration
MOVE_IZZA_DEST         = getenv("MOVE_IZZA_DEST", "")
MOVE_IZZA_AMOUNT       = getenv("MOVE_IZZA_AMOUNT", "0")
MOVE_IZZA_DEST_SECRET  = getenv("MOVE_IZZA_DEST_SECRET", "")

# Optional native payout config
NATIVE_PAYOUT_DEST   = getenv("NATIVE_PAYOUT_DEST", "")
NATIVE_PAYOUT_AMOUNT = getenv("NATIVE_PAYOUT_AMOUNT", "0")
NATIVE_PAYOUT_MEMO   = getenv("NATIVE_PAYOUT_MEMO", "IZZA test payout")

print("Loaded environment:")
print("ISSUER_PUB:", ISSUER_PUB)
print("DISTR_PUB:", DISTR_PUB)
print("HORIZON_URL:", HORIZON_URL)
print("RUN_MINT:", RUN_MINT,
      " RUN_SELL_LADDER:", RUN_SELL_LADDER,
      " RUN_MOVE_IZZA:", RUN_MOVE_IZZA,
      " RUN_AIRDROP:", RUN_AIRDROP)

# Validate keys
problems = []
if not StrKey.is_valid_ed25519_public_key(ISSUER_PUB):     problems.append("ISSUER_PUB invalid")
if not StrKey.is_valid_ed25519_public_key(DISTR_PUB):      problems.append("DISTR_PUB invalid")
if not StrKey.is_valid_ed25519_secret_seed(ISSUER_SECRET): problems.append("ISSUER_SECRET invalid")
if not StrKey.is_valid_ed25519_secret_seed(DISTR_SECRET):  problems.append("DISTR_SECRET invalid")
if problems:
    raise ValueError("Env problems: " + ", ".join(problems))

server = Server(HORIZON_URL)
asset  = Asset(ASSET_CODE, ISSUER_PUB)

def get_base_fee() -> int:
    if BASE_FEE_OVERRIDE:
        return int(BASE_FEE_OVERRIDE)
    try:
        suggested = server.fetch_base_fee()
    except Exception:
        suggested = 100
    return max(int(suggested * 20), 10_000)

def horizon_account_exists(pubkey: str) -> bool:
    try:
        server.accounts().account_id(pubkey).call()
        return True
    except NotFoundError:
        return False

def maybe_create_account(target_pub: str):
    if horizon_account_exists(target_pub):
        return
    if not FUNDING_SECRET:
        raise RuntimeError(
            f"Account {target_pub} not found.\n"
            f"Fund it manually on the Pi Testnet, then re run."
        )
    funder_kp   = Keypair.from_secret(FUNDING_SECRET)
    funder_acct = server.load_account(funder_kp.public_key)
    tx = (
        TransactionBuilder(
            source_account=funder_acct,
            network_passphrase=NETWORK_PASSPHRASE,
            base_fee=get_base_fee(),
        )
        .append_create_account_op(
            destination=target_pub,
            starting_balance=FUNDING_STARTING_BAL
        )
        .set_timeout(120)
        .build()
    )
    tx.sign(funder_kp)
    resp = server.submit_transaction(tx)
    print(f"✅ Created funded {target_pub}: {resp.get('hash')}")

def submit_and_print(tx):
    resp = server.submit_transaction(tx)
    print("✅ Success:", resp["hash"])
    print("  Ledger:", resp.get("ledger"))
    return resp

def get_izza_balance(pubkey: str) -> Decimal:
    try:
        acc = server.accounts().account_id(pubkey).call()
    except NotFoundError:
        return Decimal("0")
    for b in acc.get("balances", []):
        if (
            b.get("asset_type") in ("credit_alphanum4", "credit_alphanum12")
            and b.get("asset_code") == ASSET_CODE
            and b.get("asset_issuer") == ISSUER_PUB
        ):
            return Decimal(b.get("balance", "0"))
    return Decimal("0")

def ensure_trustline_for_secret(secret: str):
    """
    Ensure the account identified by this secret has a trustline
    for the current ASSET_CODE issued by ISSUER_PUB.
    """
    if not secret:
        return

    kp = Keypair.from_secret(secret)
    pub = kp.public_key

    try:
        acc = server.accounts().account_id(pub).call()
    except NotFoundError:
        raise RuntimeError(f"Account {pub} not found on-chain. Fund it first.")

    for b in acc.get("balances", []):
        if (
            b.get("asset_type") in ("credit_alphanum4", "credit_alphanum12")
            and b.get("asset_code") == ASSET_CODE
            and b.get("asset_issuer") == ISSUER_PUB
        ):
            print(f"✅ {pub} already has trustline for {ASSET_CODE}.")
            return

    print(f"Creating trustline for {ASSET_CODE} on {pub} …")
    acct = server.load_account(pub)
    tx = (
        TransactionBuilder(
            source_account=acct,
            network_passphrase=NETWORK_PASSPHRASE,
            base_fee=get_base_fee(),
        )
        .append_change_trust_op(
            asset=asset   # single change, use Asset object since SDK does not accept asset_code or asset_issuer kwargs
        )
        .set_timeout(180)
        .build()
    )
    tx.sign(kp)
    submit_and_print(tx)

# Set issuer options
def set_issuer_options():
    issuer_kp   = Keypair.from_secret(ISSUER_SECRET)
    issuer_acct = server.load_account(issuer_kp.public_key)

    if USE_ENUM_FLAGS:
        clear_flags = (
            AuthorizationFlag.AUTH_REQUIRED_FLAG
            | AuthorizationFlag.AUTH_REVOCABLE_FLAG
            | AuthorizationFlag.AUTH_CLAWBACK_ENABLED_FLAG
        )
    else:
        clear_flags = 11

    tx = (
        TransactionBuilder(
            source_account=issuer_acct,
            network_passphrase=NETWORK_PASSPHRASE,
            base_fee=get_base_fee(),
        )
        .append_set_options_op(
            home_domain=HOME_DOMAIN,
            clear_flags=clear_flags
        )
        .set_timeout(120)
        .build()
    )
    tx.sign(issuer_kp)
    return submit_and_print(tx)

def issuer_mint_payment():
    issuer_kp   = Keypair.from_secret(ISSUER_SECRET)
    issuer_acct = server.load_account(issuer_kp.public_key)
    tx = (
        TransactionBuilder(
            source_account=issuer_acct,
            network_passphrase=NETWORK_PASSPHRASE,
            base_fee=get_base_fee(),
        )
        .append_payment_op(
            destination=DISTR_PUB,
            amount=MINT_AMOUNT,
            asset=asset
        )
        .set_timeout(120)
        .build()
    )
    tx.sign(issuer_kp)
    return submit_and_print(tx)

# DEX offer helpers

from stellar_sdk import Asset as _AssetAlias  # noqa

def create_sell_offer(amount_izza: str, price_pi_per_izza: str):
    """
    Create a sell offer with retries for tx_bad_seq.
    """
    distr_kp = Keypair.from_secret(DISTR_SECRET)

    for attempt in range(1, 4):
        distr_acct = server.load_account(distr_kp.public_key)

        tx = (
            TransactionBuilder(
                source_account=distr_acct,
                network_passphrase=NETWORK_PASSPHRASE,
                base_fee=get_base_fee(),
            )
            .append_manage_sell_offer_op(
                selling=asset,
                buying=Asset.native(),
                amount=str(Decimal(amount_izza)),
                price=str(Decimal(price_pi_per_izza)),
                offer_id=0
            )
            .set_timeout(180)
            .build()
        )
        tx.sign(distr_kp)

        try:
            resp = submit_and_print(tx)
            print(f"📈 Posted offer: {amount_izza} {ASSET_CODE} @ {price_pi_per_izza} Pi")
            return resp
        except BadRequestError as e:
            msg = str(e)
            if "tx_bad_seq" in msg and attempt < 3:
                print(f"⚠️ tx_bad_seq on offer {amount_izza}@{price_pi_per_izza}, "
                      f"retrying (attempt {attempt+1}/3)…")
                continue
            raise

def seed_sell_ladder_basic(total_amount: int,
                           chunk_amount: int = 10_000,
                           start_price: Decimal = Decimal("0.0005"),
                           step: Decimal = Decimal("0.001")):
    remaining = int(total_amount)
    i = 0
    while remaining > 0:
        this_chunk = min(chunk_amount, remaining)
        price = start_price + (step * i)
        create_sell_offer(amount_izza=str(this_chunk), price_pi_per_izza=str(price))
        remaining -= this_chunk
        i += 1
    print("✅ Sale ladder seeded.")

def cancel_all_izza_offers():
    """
    Cancel all sell offers for the current ASSET_CODE (and ISSUER_PUB)
    for this distributor, scanning through all offer pages in safe
    batches (<= 90 ops per tx).
    """
    distr_kp = Keypair.from_secret(DISTR_SECRET)

    # Collect all matching offers across pages
    izza_offers = []
    cursor = None

    while True:
        call = server.offers().for_seller(distr_kp.public_key).limit(200)
        if cursor:
            call = call.cursor(cursor)
        page = call.call()

        offers = page.get("_embedded", {}).get("records", [])
        if not offers:
            break

        for o in offers:
            selling = o.get("selling", {})
            if (
                selling.get("asset_type") in ("credit_alphanum4", "credit_alphanum12")
                and selling.get("asset_code") == ASSET_CODE
                and selling.get("asset_issuer") == ISSUER_PUB
            ):
                izza_offers.append(o)

        next_href = page.get("_links", {}).get("next", {}).get("href")
        if not next_href or "cursor=" not in next_href:
            break
        cursor = next_href.split("cursor=")[-1].split("&")[0] or None

    if not izza_offers:
        print(f"No {ASSET_CODE} offers to cancel.")
        return

    print(f"Found {len(izza_offers)} {ASSET_CODE} offers. Cancelling in batches…")

    batch_size = 90
    total_cancelled = 0

    for i in range(0, len(izza_offers), batch_size):
        batch = izza_offers[i:i + batch_size]

        distr_acct = server.load_account(distr_kp.public_key)
        tb = TransactionBuilder(
            source_account=distr_acct,
            network_passphrase=NETWORK_PASSPHRASE,
            base_fee=get_base_fee(),
        )

        for o in batch:
            tb.append_manage_sell_offer_op(
                selling=asset,
                buying=Asset.native(),
                amount="0",
                price=o["price"],
                offer_id=int(o["id"])
            )

        tx = tb.set_timeout(180).build()
        tx.sign(distr_kp)
        submit_and_print(tx)

        total_cancelled += len(batch)
        print(f"🧹 Cancelled {len(batch)} offers in this batch.")

    print(f"✅ Canceled {total_cancelled} {ASSET_CODE} offers in total.")

def seed_ladder_to_target(total_amount: int,
                          chunk_amount: int,
                          start_price: Decimal,
                          end_price: Decimal,
                          mode: str = "geometric"):
    total_amount = int(total_amount)
    chunk_amount = int(chunk_amount)
    if total_amount <= 0 or chunk_amount <= 0:
        print("⚠️  Nothing to seed.")
        return

    rungs = math.ceil(total_amount / chunk_amount)
    if rungs < 1:
        return

    sp = Decimal(start_price)
    ep = Decimal(end_price)

    prices = []
    if rungs == 1:
        prices = [ep]
    else:
        if mode == "linear":
            step = (ep - sp) / Decimal(rungs - 1)
            prices = [sp + step * i for i in range(rungs)]
        else:
            factor = (ep / sp) ** (Decimal(1) / Decimal(rungs - 1))
            prices = [sp * (factor ** i) for i in range(rungs)]

    remaining = total_amount
    for p in prices:
        this_chunk = min(chunk_amount, remaining)
        if this_chunk <= 0:
            break
        create_sell_offer(amount_izza=str(this_chunk), price_pi_per_izza=str(p))
        remaining -= this_chunk

    print(f"✅ Ladder seeded: {len(prices)} rungs from {prices[0]:f} to {prices[-1]:f}")

def seed_hype_sell_ladder(total_amount: int,
                          start_price: Decimal,
                          end_price: Decimal,
                          min_chunk: int,
                          max_chunk: int,
                          wiggle_pct: Decimal):
    """
    Hype ladder tuned for retail sized buys.
    Uses many small offers, so a 50 to 100 test Pi buyer can move price.
    """
    total_amount = int(total_amount)
    if total_amount <= 0:
        print("⚠️  Nothing to seed.")
        return

    if min_chunk <= 0 or max_chunk <= 0 or min_chunk > max_chunk:
        avg_chunk = max(1, total_amount // 50)
        min_chunk = max(1, avg_chunk // 2)
        max_chunk = max(min_chunk, avg_chunk * 2)

    expected_chunk = (min_chunk + max_chunk) // 2
    est_rungs = max(1, math.ceil(total_amount / expected_chunk))

    sp = Decimal(start_price)
    ep = Decimal(end_price)

    remaining = total_amount
    rung_index = 0
    last_price = sp

    print(f"Seeding hype ladder for {total_amount} {ASSET_CODE} from {sp} to {ep} with about {est_rungs} rungs …")

    while remaining > 0:
        if est_rungs > 1:
            t = Decimal(rung_index) / Decimal(est_rungs - 1)
        else:
            t = Decimal("1")

        if sp > 0:
            base_factor = (ep / sp) ** t if ep > 0 else Decimal("1")
            base_price = sp * base_factor
        else:
            base_price = ep

        if wiggle_pct > 0:
            w = random.uniform(float(-wiggle_pct), float(wiggle_pct))
            base_price = base_price * (Decimal("1") + Decimal(str(w)))

        if rung_index == 0:
            price = max(sp, min(base_price, ep))
        else:
            if base_price <= last_price:
                remaining_steps = max(1, est_rungs - rung_index)
                step_up = (ep - last_price) / Decimal(remaining_steps)
                if step_up <= 0:
                    step_up = Decimal("0.0001")
                price = last_price + step_up
            else:
                price = base_price

            if price > ep:
                price = ep

        chunk = random.randint(min_chunk, max_chunk)
        if chunk > remaining:
            chunk = remaining

        price_q = price.quantize(Decimal("0.0000001"))
        create_sell_offer(amount_izza=str(chunk), price_pi_per_izza=str(price_q))

        remaining -= chunk
        last_price = price
        rung_index += 1

    print(f"✅ Hype ladder seeded: {rung_index} offers from {sp} to {last_price}")

# Native test Pi payment helper

def send_native_payment(destination_pub: str, amount_pi: str, memo_text: str = ""):
    distr_kp   = Keypair.from_secret(DISTR_SECRET)
    distr_acct = server.load_account(distr_kp.public_key)

    tb = (
        TransactionBuilder(
            source_account=distr_acct,
            network_passphrase=NETWORK_PASSPHRASE,
            base_fee=get_base_fee(),
        )
        .append_payment_op(
            destination=destination_pub,
            amount=str(Decimal(amount_pi)),
            asset=Asset.native()
        )
        .set_timeout(180)
    )
    if memo_text:
        tb.add_text_memo(memo_text[:28])

    tx = tb.build()
    tx.sign(distr_kp)
    return submit_and_print(tx)

# Distributor to wallet IZZA transfer

def distributor_send_izza(destination_pub: str, amount_izza: str):
    if not StrKey.is_valid_ed25519_public_key(destination_pub):
        raise ValueError("MOVE_IZZA_DEST is not a valid public key")

    amount_dec = Decimal(amount_izza)
    if amount_dec <= 0:
        raise ValueError("MOVE_IZZA_AMOUNT must be greater than 0")

    bal = get_izza_balance(DISTR_PUB)
    print(f"Distributor IZZA balance before move: {bal}")
    if bal < amount_dec:
        raise RuntimeError(f"Not enough IZZA in distributor. Have {bal}, need {amount_dec}")

    distr_kp   = Keypair.from_secret(DISTR_SECRET)
    distr_acct = server.load_account(distr_kp.public_key)

    tx = (
        TransactionBuilder(
            source_account=distr_acct,
            network_passphrase=NETWORK_PASSPHRASE,
            base_fee=get_base_fee(),
        )
        .append_payment_op(
            destination=destination_pub,
            amount=str(amount_dec),
            asset=asset
        )
        .set_timeout(180)
        .build()
    )
    tx.sign(distr_kp)
    resp = submit_and_print(tx)
    print(f"🚚 Moved {amount_dec} {ASSET_CODE} from distributor to {destination_pub}")
    return resp

# Enumerate IZZA trustline holders

def iter_izza_trustline_holders():
    cursor = None
    seen = set()
    while True:
        call = server.accounts().for_asset(asset).limit(200)
        if cursor:
            call = call.cursor(cursor)
        page = call.call()
        records = page.get("_embedded", {}).get("records", [])
        if not records:
            break

        for acc in records:
            acct_id = acc.get("account_id")
            if not acct_id:
                continue
            if acct_id in (ISSUER_PUB, DISTR_PUB):
                continue
            if acct_id in seen:
                continue
            seen.add(acct_id)
            yield acct_id

        next_href = page.get("_links", {}).get("next", {}).get("href")
        if not next_href or "cursor=" not in next_href:
            break
        cursor = next_href.split("cursor=")[-1].split("&")[0] or None

def ensure_airdrop_table(cx):
    cx.execute("""
      CREATE TABLE IF NOT EXISTS izza_airdrops(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet_pub TEXT NOT NULL,
        tag TEXT,
        amount TEXT,
        tx_hash TEXT,
        created_at INTEGER,
        UNIQUE(wallet_pub, tag)
      );
    """)

def run_izza_airdrop():
    """
    On each run it prints
      total current trustline holders
      total wallets ever recorded for this tag
      how many of the current trustline holders already have this tag
      how many trustlines will be attempted this run
    """
    try:
        amt_dec = Decimal(AIRDROP_AMOUNT)
    except Exception:
        raise ValueError("AIRDROP_AMOUNT must be numeric")

    if amt_dec <= 0:
        print("⚠️  AIRDROP_AMOUNT is <= 0, skipping airdrop.")
        return

    if AIRDROP_SINGLE_DEST:
        holders = [AIRDROP_SINGLE_DEST]
        print(f"🔬 Test mode: airdrop will ONLY be sent to {AIRDROP_SINGLE_DEST}")
    else:
        holders = list(iter_izza_trustline_holders())
        if not holders:
            print("⚠️  No IZZA trustline holders found for airdrop.")
            return

    total_candidates = len(holders)
    total_needed     = amt_dec * Decimal(total_candidates)
    dist_bal         = get_izza_balance(DISTR_PUB)

    print(f"Airdrop config: amount={amt_dec} per wallet, "
          f"holders={total_candidates}, "
          f"needed={total_needed}, distributor_balance={dist_bal}")

    if dist_bal < total_needed:
        print("⚠️  Not enough IZZA in distributor to cover full airdrop, aborting.")
        return

    distr_kp   = Keypair.from_secret(DISTR_SECRET)
    distr_acct = server.load_account(distr_kp.public_key)
    base_fee   = get_base_fee()
    now_ts     = int(time.time())
    tag_value  = AIRDROP_TAG or None

    holders_set = set(holders)

    with app_db.conn() as cx:
        ensure_airdrop_table(cx)

        if tag_value is not None:
            rows = cx.execute(
                "SELECT DISTINCT wallet_pub FROM izza_airdrops WHERE tag = ?",
                (tag_value,)
            ).fetchall()
        else:
            rows = cx.execute(
                "SELECT DISTINCT wallet_pub FROM izza_airdrops WHERE tag IS NULL"
            ).fetchall()

        all_tag_wallets = {r[0] for r in rows}
        total_tag_wallets = len(all_tag_wallets)

        already_had = len(holders_set & all_tag_wallets)

        will_attempt_this_run = max(0, total_candidates - already_had)

        print(f"Tag '{tag_value}' summary before this run:")
        print(f"  wallets ever recorded for this tag:          {total_tag_wallets}")
        print(f"  current IZZA trustline holders:             {total_candidates}")
        print(f"  trustline holders already sent for this tag:{already_had}")
        print(f"  trustlines that will be attempted this run: {will_attempt_this_run}")

        sent    = 0
        skipped = 0
        failed  = 0

        for idx, pub in enumerate(holders, start=1):
            if tag_value is not None:
                row = cx.execute(
                    "SELECT 1 FROM izza_airdrops WHERE wallet_pub = ? AND tag = ?",

**Oops, that hit the message length cap.**

The only part I actually changed is `cancel_all_izza_offers()`, everything else before and after stays exactly as in your original file.

To wire it in surgically, replace just your current `cancel_all_izza_offers` function with this version:

```python
def cancel_all_izza_offers():
    """
    Cancel all sell offers for the current ASSET_CODE (and ISSUER_PUB)
    for this distributor, scanning through all offer pages in safe
    batches (<= 90 ops per tx).
    """
    distr_kp = Keypair.from_secret(DISTR_SECRET)

    # Collect all matching offers across pages
    izza_offers = []
    cursor = None

    while True:
        call = server.offers().for_seller(distr_kp.public_key).limit(200)
        if cursor:
            call = call.cursor(cursor)
        page = call.call()

        offers = page.get("_embedded", {}).get("records", [])
        if not offers:
            break

        for o in offers:
            selling = o.get("selling", {})
            if (
                selling.get("asset_type") in ("credit_alphanum4", "credit_alphanum12")
                and selling.get("asset_code") == ASSET_CODE
                and selling.get("asset_issuer") == ISSUER_PUB
            ):
                izza_offers.append(o)

        next_href = page.get("_links", {}).get("next", {}).get("href")
        if not next_href or "cursor=" not in next_href:
            break
        cursor = next_href.split("cursor=")[-1].split("&")[0] or None

    if not izza_offers:
        print(f"No {ASSET_CODE} offers to cancel.")
        return

    print(f"Found {len(izza_offers)} {ASSET_CODE} offers. Cancelling in batches…")

    batch_size = 90
    total_cancelled = 0

    for i in range(0, len(izza_offers), batch_size):
        batch = izza_offers[i:i + batch_size]

        distr_acct = server.load_account(distr_kp.public_key)
        tb = TransactionBuilder(
            source_account=distr_acct,
            network_passphrase=NETWORK_PASSPHRASE,
            base_fee=get_base_fee(),
        )

        for o in batch:
            tb.append_manage_sell_offer_op(
                selling=asset,
                buying=Asset.native(),
                amount="0",
                price=o["price"],
                offer_id=int(o["id"])
            )

        tx = tb.set_timeout(180).build()
        tx.sign(distr_kp)
        submit_and_print(tx)

        total_cancelled += len(batch)
        print(f"🧹 Cancelled {len(batch)} offers in this batch.")

    print(f"✅ Canceled {total_cancelled} {ASSET_CODE} offers in total.")
