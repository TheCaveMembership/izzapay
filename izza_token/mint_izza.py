import os
from decimal import Decimal
from dotenv import load_dotenv
from stellar_sdk import (
    Server,
    Keypair,
    TransactionBuilder,
    Asset,
    StrKey,
)
from stellar_sdk.exceptions import NotFoundError

# Try to import AuthorizationFlag, but verify its attributes exist
try:
    from stellar_sdk.operation.set_options import AuthorizationFlag
    if all(hasattr(AuthorizationFlag, n) for n in [
        "AUTH_REQUIRED_FLAG", "AUTH_REVOCABLE_FLAG", "AUTH_CLAWBACK_ENABLED_FLAG"
    ]):
        USE_ENUM_FLAGS = True
    else:
        USE_ENUM_FLAGS = False
except ImportError:
    USE_ENUM_FLAGS = False

load_dotenv()

# ---- Load & sanitize env ----
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

print("Loaded environment:")
print("ISSUER_PUB:", ISSUER_PUB)
print("DISTR_PUB:", DISTR_PUB)
print("HORIZON_URL:", HORIZON_URL)

# ---- Validate keys ----
problems = []
if not StrKey.is_valid_ed25519_public_key(ISSUER_PUB):     problems.append("ISSUER_PUB invalid")
if not StrKey.is_valid_ed25519_public_key(DISTR_PUB):      problems.append("DISTR_PUB invalid")
if not StrKey.is_valid_ed25519_secret_seed(ISSUER_SECRET): problems.append("ISSUER_SECRET invalid")
if not StrKey.is_valid_ed25519_secret_seed(DISTR_SECRET):  problems.append("DISTR_SECRET invalid")
if problems:
    raise ValueError("Env problems: " + ", ".join(problems))

server = Server(HORIZON_URL)
asset  = Asset(ASSET_CODE, ISSUER_PUB)

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
            base_fee=200
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

    # Determine how to represent flags based on SDK
    if USE_ENUM_FLAGS:
        try:
            clear_flags = [
                AuthorizationFlag.AUTH_REQUIRED_FLAG,
                AuthorizationFlag.AUTH_REVOCABLE_FLAG,
                AuthorizationFlag.AUTH_CLAWBACK_ENABLED_FLAG,
            ]
        except Exception:
            clear_flags = AuthorizationFlag(11)
    else:
        # Fallback to combined integer bitmask
        clear_flags = 11  # 1 + 2 + 8

    tx = (
        TransactionBuilder(
            source_account=issuer_acct,
            network_passphrase=NETWORK_PASSPHRASE,
            base_fee=200
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
            base_fee=200
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
            base_fee=200
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

    print("\nAll done. Verify balances at:")
    print(f"  Issuer:      {HORIZON_URL}/accounts/{ISSUER_PUB}")
    print(f"  Distributor: {HORIZON_URL}/accounts/{DISTR_PUB}")
