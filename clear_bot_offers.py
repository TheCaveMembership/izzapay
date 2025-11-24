# clear_bot_offers.py
#
# Cancels ALL open offers for the bot trader account
# Uses amount=0 manage_*_offer ops, which deletes the offer on chain.

import os
from stellar_sdk import (
    Server,
    Keypair,
    TransactionBuilder,
    Network,
    Asset,
    ManageSellOffer,
    ManageBuyOffer,
)

HORIZON_URL = os.environ["HORIZON_URL"]
NETWORK_PASSPHRASE = os.getenv("NETWORK_PASSPHRASE", "Pi Testnet")

# Try a few common env var names for the bot key
BOT_SECRET = (
    os.getenv("BOT_SECRET")
    or os.getenv("TRADER_SECRET")
    or os.getenv("BOT_TRADER_SECRET")
)

if not BOT_SECRET:
    raise RuntimeError(
        "Set BOT_SECRET or TRADER_SECRET or BOT_TRADER_SECRET in the environment"
    )

server = Server(HORIZON_URL)
kp = Keypair.from_secret(BOT_SECRET)
bot_pub = kp.public_key

print(f"Clearing offers for bot account {bot_pub}")

def asset_from_json(j):
    """Convert Horizon asset JSON into a stellar_sdk Asset."""
    asset_type = j["asset_type"]
    if asset_type == "native":
        return Asset.native()
    code = j["asset_code"]
    issuer = j["asset_issuer"]
    return Asset(code, issuer)

def fetch_all_offers():
    """Fetch all offers for the bot account, following pagination."""
    offers = []
    call = server.offers().for_seller(bot_pub).limit(200).call()
    offers.extend(call["_embedded"]["records"])
    while "next" in call["_links"]:
        next_href = call["_links"]["next"]["href"]
        call = server._session.get(next_href).json()
        recs = call.get("_embedded", {}).get("records", [])
        if not recs:
            break
        offers.extend(recs)
    return offers

offers = fetch_all_offers()
print(f"Found {len(offers)} open offers")

if not offers:
    print("Nothing to do.")
    raise SystemExit(0)

account = server.load_account(bot_pub)
base_fee = server.fetch_base_fee()

tx_builder = TransactionBuilder(
    source_account=account,
    network_passphrase=NETWORK_PASSPHRASE,
    base_fee=base_fee,
)

ops_count = 0
for off in offers:
    offer_id = int(off["id"])
    selling = asset_from_json(off["selling"])
    buying = asset_from_json(off["buying"])

    # price_r is more precise than price
    pr = off.get("price_r") or {"n": 1, "d": 1}
    price = pr["n"] / pr["d"]

    # Decide whether this was originally a buy or sell offer
    # If the seller is selling the token and buying PI, that is a sell offer.
    # If the seller is selling PI and buying the token, that is a buy offer.
    is_selling_native = off["selling"]["asset_type"] == "native"
    is_buying_native = off["buying"]["asset_type"] == "native"

    if is_buying_native:
        # sell token for PI  manage sell offer
        op = ManageSellOffer(
            selling=selling,
            buying=buying,
            amount="0",        # 0 cancels the offer
            price=str(price),
            offer_id=offer_id,
        )
    elif is_selling_native:
        # sell PI for token  manage buy offer
        op = ManageBuyOffer(
            selling=selling,
            buying=buying,
            buy_amount="0",    # 0 cancels the offer
            price=str(price),
            offer_id=offer_id,
        )
    else:
        # token to token, treat as generic sell
        op = ManageSellOffer(
            selling=selling,
            buying=buying,
            amount="0",
            price=str(price),
            offer_id=offer_id,
        )

    tx_builder.append_operation(op)
    ops_count += 1

print(f"Appending {ops_count} cancel operations to a single transaction")

tx = tx_builder.build()
tx.sign(kp)
resp = server.submit_transaction(tx)

print("Submit response:", resp["hash"])
print("All current offers for the bot should now be deleted.")
