import os
from decimal import Decimal
from dotenv import load_dotenv
from stellar_sdk import Server, Keypair, TransactionBuilder, Asset, StrKey
from stellar_sdk.exceptions import NotFoundError

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
MINT_AMOUNT = getenv("MINT_AMOUNT", "1000000.0000000")
HOME_DOMAIN = getenv("HOME_DOMAIN", "izzapay.onrender.com")

FUNDING_SECRET       = getenv("FUNDING_SECRET", "")
FUNDING_STARTING_BAL = getenv("FUNDING_STARTING_BALANCE", "5")

# Optional manual override via env
BASE_FEE_OVERRIDE = getenv("BASE_FEE", "")

# Runtime switches (safe defaults)
RUN_MINT         = getenv("RUN_MINT", "0") == "1"          # default: don't mint again
RUN_SELL_LADDER  = getenv("RUN_SELL_LADDER", "1") == "1"   # default: DO seed the sale ladder

print("Loaded environment:")
print("ISSUER_PUB:", ISSUER_PUB)
print("DISTR_PUB:", DISTR_PUB)
print("HORIZON_URL:", HORIZON_URL)
print("RUN_MINT:", RUN_MINT, " RUN_SELL_LADDER:", RUN_SELL_LADDER)

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
    """Pick a safe base fee in stroops."""
    if BASE_FEE_OVERRIDE:
        return int(BASE_FEE_OVERRIDE)
    try:
        suggested = server.fetch_base_fee()  # stroops per op
    except Exception:
        suggested = 100
    # Pi Testnet tends to need more; multiply and floor.
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
            f"Fund it manually on the Pi Testnet, then re-run."
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
    print(f"✅ Created/funded {target_pub}: {resp.get('hash')}")

def submit_and_print(tx):
    resp = server.submit_transaction(tx)
    print("✅ Success:", resp["hash"])
    print("  Ledger:", resp.get("ledger"))
    return resp

def get_izza_balance(pubkey: str) -> Decimal:
    """Return IZZA balance for an account (0 if no trustline)."""
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

# ---- Set issuer options ----
def set_issuer_options():
    issuer_kp   = Keypair.from_secret(ISSUER_SECRET)
    issuer_acct = server.load_account(issuer_kp.public_key)

    # Use ONE combined bitmask, not a list
    if USE_ENUM_FLAGS:
        clear_flags = (
            AuthorizationFlag.AUTH_REQUIRED_FLAG
            | AuthorizationFlag.AUTH_REVOCABLE_FLAG
            | AuthorizationFlag.AUTH_CLAWBACK_ENABLED_FLAG
        )
    else:
        clear_flags = 11  # 1 + 2 + 8

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

def distributor_change_trust():
    distr_kp   = Keypair.from_secret(DISTR_SECRET)
    distr_acct = server.load_account(distr_kp.public_key)
    tx = (
        TransactionBuilder(
            source_account=distr_acct,
            network_passphrase=NETWORK_PASSPHRASE,
            base_fee=get_base_fee(),
        )
        .append_change_trust_op(
            asset=asset,
            limit=str(Decimal("922337203685.4775807"))
        )
        .set_timeout(120)
        .build()
    )
    tx.sign(distr_kp)
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

# ==================== DEX OFFER HELPERS (ADD HERE) ====================

from stellar_sdk import Asset as _AssetAlias  # not strictly needed; Asset.native() already imported

def create_sell_offer(amount_izza: str, price_pi_per_izza: str):
    """
    Post a single sell offer: SELL IZZA for native (Pi) at a fixed price.
    amount_izza: how many IZZA to sell in this offer
    price_pi_per_izza: quoted as Pi per 1 IZZA (e.g., '0.001')
    """
    distr_kp   = Keypair.from_secret(DISTR_SECRET)
    distr_acct = server.load_account(distr_kp.public_key)

    tx = (
        TransactionBuilder(
            source_account=distr_acct,
            network_passphrase=NETWORK_PASSPHRASE,
            base_fee=get_base_fee(),
        )
        .append_manage_sell_offer_op(
            selling=asset,                 # IZZA (your asset)
            buying=Asset.native(),         # buy Pi (native)
            amount=str(Decimal(amount_izza)),
            price=str(Decimal(price_pi_per_izza)),
            offer_id=0                     # 0 = create new offer
        )
        .set_timeout(180)
        .build()
    )
    tx.sign(distr_kp)
    resp = submit_and_print(tx)
    print(f"📈 Posted offer: {amount_izza} IZZA @ {price_pi_per_izza} Pi")
    return resp

def seed_sale_ladder(total_amount: int,
                     chunk_amount: int = 10_000,
                     start_price: Decimal = Decimal("0.0005"),
                     step: Decimal = Decimal("0.001")):
    """
    Seed a ladder of offers so that for each 'chunk_amount' sold, the next
    remaining offer is +step Pi higher.
    """
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
    """Cancel all existing IZZA sell offers from the distributor."""
    distr_kp = Keypair.from_secret(DISTR_SECRET)
    offers = server.offers().seller(distr_kp.public_key).call()["_embedded"]["records"]
    izza_offers = [o for o in offers
                   if o.get("selling", {}).get("asset_code") == ASSET_CODE
                   and o.get("selling", {}).get("asset_issuer") == ISSUER_PUB]

    if not izza_offers:
        print("No IZZA offers to cancel.")
        return

    distr_acct = server.load_account(distr_kp.public_key)
    tb = TransactionBuilder(
        source_account=distr_acct,
        network_passphrase=NETWORK_PASSPHRASE,
        base_fee=get_base_fee(),
    )
    for o in izza_offers:
        tb.append_manage_sell_offer_op(
            selling=asset,
            buying=Asset.native(),
            amount="0",                  # amount=0 => cancel existing offer
            price=o["price"],            # must include a price even when canceling
            offer_id=int(o["id"])
        )
    tx = tb.set_timeout(180).build()
    tx.sign(distr_kp)
    submit_and_print(tx)
    print(f"🧹 Canceled {len(izza_offers)} IZZA offers.")

# -------- NEW: Ladder-to-target helper (linear or geometric) --------
import math

def seed_ladder_to_target(total_amount: int,
                          chunk_amount: int,
                          start_price: Decimal,
                          end_price: Decimal,
                          mode: str = "geometric"):
    """
    Build a ladder from start_price up to end_price across N rungs so that the
    last rung reaches end_price. 'mode' = 'linear' or 'geometric'.
    """
    total_amount = int(total_amount)
    chunk_amount = int(chunk_amount)
    if total_amount <= 0 or chunk_amount <= 0:
        print("⚠️  Nothing to seed (total or chunk is 0).")
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

    print(f"✅ Ladder seeded: {len(prices)} rungs from {prices[0]:f} → {prices[-1]:f}")
# -------------------- END new helper --------------------

# ================== END DEX OFFER HELPERS (STOP ADDING) ==================

# =============== NATIVE (TEST PI) PAYMENT HELPER ===============
def send_native_payment(destination_pub: str, amount_pi: str, memo_text: str = ""):
    """
    Send native (test Pi) from the DISTR_PUB to destination_pub.
    amount_pi must be a string like "2300" or "2300.0000000".
    """
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
        tb.add_text_memo(memo_text[:28])  # Horizon text memos max 28 bytes

    tx = tb.build()
    tx.sign(distr_kp)
    return submit_and_print(tx)
# ===============================================================

if __name__ == "__main__":
    print("Checking accounts exist on-chain …")
    maybe_create_account(ISSUER_PUB)
    maybe_create_account(DISTR_PUB)

    print("Step 1/4: Set issuer options … (idempotent)")
    set_issuer_options()

    print("Step 2/4: Distributor change-trust … (idempotent)")
    distributor_change_trust()

    # SAFE MINT GUARD:
    # Only mint if explicitly enabled AND distributor has zero IZZA balance.
    # This prevents accidental re-minting when re-running the script.
    print("Step 3/4: Conditional mint check …")
    current_bal = get_izza_balance(DISTR_PUB)
    print(f"Distributor IZZA balance: {current_bal}")
    if RUN_MINT:
        if current_bal > Decimal("0"):
            print("⏭️  Skipping mint: distributor already holds IZZA.")
        else:
            print("Mint enabled and distributor has 0 IZZA → minting …")
            issuer_mint_payment()
    else:
        print("⏭️  RUN_MINT is 0 (default). Mint step skipped.")

    # --- Step 4: Seed public sale ladder (Growth allocation) ---
    # Will auto-cap at available distributor balance to avoid failures.
    if RUN_SELL_LADDER:
        print("Step 4/4: Seed DEX sale ladder …")
        # refresh balance in case we minted this run
        current_bal = get_izza_balance(DISTR_PUB)
        target_to_sell = Decimal("400000")
        sellable = min(current_bal, target_to_sell)
        if sellable <= 0:
            print("⚠️  No IZZA available to post offers. Skipping ladder.")
        else:
            # Round down to integer tokens
            sellable_int = int(sellable.to_integral_value(rounding="ROUND_FLOOR"))
            print(f"Posting ladder for {sellable_int} IZZA …")

            # --- NEW: env-tunable ladder to a target end price (defaults ok) ---
            ladder_chunk = int(getenv("LADDER_CHUNK", "10000"))
            ladder_total = int(getenv("LADDER_TOTAL", str(sellable_int)))
            ladder_start = Decimal(getenv("LADDER_START_PRICE", "0.0005"))
            ladder_end   = Decimal(getenv("LADDER_END_PRICE",  "1.0"))
            ladder_mode  = getenv("LADDER_MODE", "geometric")  # or "linear"

            seed_ladder_to_target(
                total_amount=ladder_total,
                chunk_amount=ladder_chunk,
                start_price=ladder_start,
                end_price=ladder_end,
                mode=ladder_mode
            )
    else:
        print("⏭️  RUN_SELL_LADDER is 0. Skipping offer creation.")

    # --- OPTIONAL: send native test Pi out of distributor ---
    DEST_PI = "GDDFUCFIWEXARKUPKBU5SKXBQSUNTBPQQEDYHGYJGSZFYCGCGZO5X7CT"
    AMOUNT  = "2100"  # test Pi to send

    # If you're unsure the destination exists on-chain, you can create/fund it first:
    # maybe_create_account(DEST_PI)

    print(f"\nSending {AMOUNT} test Pi to {DEST_PI} …")
    send_native_payment(DEST_PI, AMOUNT, memo_text="IZZA test payout")

    print("\nAll done. Verify balances/offers at:")
    print(f"  Issuer:      {HORIZON_URL}/accounts/{ISSUER_PUB}")
    print(f"  Distributor: {HORIZON_URL}/accounts/{DISTR_PUB}")
    print(f"  Offers API:  {HORIZON_URL}/offers?seller={DISTR_PUB}")
