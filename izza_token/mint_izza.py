import os
from decimal import Decimal
from dotenv import load_dotenv
from stellar_sdk import Server, Keypair, Network, TransactionBuilder, Asset, SetOptions, ChangeTrust, Payment

load_dotenv()

HORIZON_URL = os.environ["HORIZON_URL"]
NETWORK_PASSPHRASE = os.environ["NETWORK_PASSPHRASE"]

ISSUER_PUB = os.environ["ISSUER_PUB"]
ISSUER_SECRET = os.environ["ISSUER_SECRET"]
DISTR_PUB = os.environ["DISTR_PUB"]
DISTR_SECRET = os.environ["DISTR_SECRET"]

ASSET_CODE = os.environ.get("ASSET_CODE", "IZZA")
MINT_AMOUNT = os.environ.get("MINT_AMOUNT", "1000000.0000000")
HOME_DOMAIN = os.environ.get("HOME_DOMAIN", "izzapay.onrender.com")

server = Server(HORIZON_URL)
asset = Asset(ASSET_CODE, ISSUER_PUB)

def submit_and_print(tx):
    try:
        resp = server.submit_transaction(tx)
        print("✅ Success:", resp["hash"])
        print("  Ledger:", resp.get("ledger"))
        return resp
    except Exception as e:
        print("❌ Submit failed:", e)
        raise

def set_issuer_options():
    issuer_kp = Keypair.from_secret(ISSUER_SECRET)
    issuer_acct = server.load_account(issuer_kp.public_key)

    # Clear any auth flags (no approval needed) + set home_domain
    # On Stellar/Pi: clear_flags takes a list of flags to ensure they're OFF.
    # Available flags: AUTH_REQUIRED_FLAG, AUTH_REVOCABLE_FLAG, AUTH_CLAWBACK_ENABLED_FLAG
    tx = (
        TransactionBuilder(
            source_account=issuer_acct,
            network_passphrase=NETWORK_PASSPHRASE,
            base_fee=200
        )
        .append_set_options_op(
            home_domain=HOME_DOMAIN,
            clear_flags=[
                SetOptions.AUTH_REQUIRED_FLAG,
                SetOptions.AUTH_REVOCABLE_FLAG,
                SetOptions.AUTH_CLAWBACK_ENABLED_FLAG
            ]
        )
        .set_timeout(120)
        .build()
    )
    tx.sign(issuer_kp)
    return submit_and_print(tx)

def distributor_change_trust():
    distr_kp = Keypair.from_secret(DISTR_SECRET)
    distr_acct = server.load_account(distr_kp.public_key)

    tx = (
        TransactionBuilder(
            source_account=distr_acct,
            network_passphrase=NETWORK_PASSPHRASE,
            base_fee=200
        )
        .append_change_trust_op(
            asset=asset,
            limit=str(Decimal("922337203685.4775807"))  # effectively "max"
        )
        .set_timeout(120)
        .build()
    )
    tx.sign(distr_kp)
    return submit_and_print(tx)

def issuer_mint_payment():
    issuer_kp = Keypair.from_secret(ISSUER_SECRET)
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
    print("Step 1/3: Set issuer options …")
    set_issuer_options()

    print("Step 2/3: Distributor change-trust …")
    distributor_change_trust()

    print("Step 3/3: Mint payment issuer → distributor …")
    issuer_mint_payment()

    print("\nAll done. Verify balances at:")
    print(f"  {HORIZON_URL}/accounts/{DISTR_PUB}")
