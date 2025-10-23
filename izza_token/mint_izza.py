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

print("Loaded environment:")
print("ISSUER_PUB:", ISSUER_PUB)
print("DISTR_PUB:", DISTR_PUB)
print("HORIZON_URL:", HORIZON_URL)

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

# ================== END DEX OFFER HELPERS (STOP ADDING) ==================

if __name__ == "__main__":
    print("Checking accounts exist on-chain …")
    maybe_create_account(ISSUER_PUB)
    maybe_create_account(DISTR_PUB)

    print("Step 1/3: Set issuer options …")
    set_issuer_options()

    print("Step 2/3: Distributor change-trust …")
    distributor_change_trust()

    print("Step 3/3: Mint payment issuer → distributor …")
    issuer_mint_payment()

    # --- Step 4: Seed public sale ladder (Growth allocation) ---
    # 400,000 IZZA total, 10,000 per rung, start at 0.0005 Pi and +0.001 each step
    print("Step 4/4: Seed DEX sale ladder …")
    seed_sale_ladder(
        total_amount=400_000,
        chunk_amount=10_000,
        start_price=Decimal("0.0005"),
        step=Decimal("0.001")
    )

    print("\nAll done. Verify balances/offers at:")
    print(f"  Issuer:      {HORIZON_URL}/accounts/{ISSUER_PUB}")
    print(f"  Distributor: {HORIZON_URL}/accounts/{DISTR_PUB}")
