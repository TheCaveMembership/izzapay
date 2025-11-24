# reset_bot_cammac.py
#
# One-off maintenance script to reset all bot state
# for the user @cammac:
#   - clears trades
#   - clears positions
#   - clears bucket transfers
#   - zeroes bucket allocations
#
# Does NOT delete the buckets or the account itself.

from db import conn

TARGET_USERNAME = "cammac"

def main():
    with conn() as cx:
        # 1) Find the bot account for this username
        acct = cx.execute(
            "SELECT id, username FROM bot_accounts WHERE username = ?",
            (TARGET_USERNAME,),
        ).fetchone()

        if not acct:
            print(f"[RESET] No bot_account found for username={TARGET_USERNAME!r}")
            return

        account_id = acct["id"]
        print(f"[RESET] Found bot_account id={account_id} username=@{acct['username']}")

        # 2) Get all bucket ids for this account
        bucket_rows = cx.execute(
            "SELECT id, risk_level FROM bot_buckets WHERE account_id = ?",
            (account_id,),
        ).fetchall()

        if not bucket_rows:
            print(f"[RESET] No bot_buckets found for account_id={account_id}")
            return

        bucket_ids = [row["id"] for row in bucket_rows]
        print(f"[RESET] Buckets for @{TARGET_USERNAME}: {bucket_ids}")

        placeholders = ",".join("?" for _ in bucket_ids)

        # 3) Delete trades for this account
        print("[RESET] Deleting bot_trades for this account...")
        cx.execute(
            "DELETE FROM bot_trades WHERE account_id = ?",
            (account_id,),
        )

        # 4) Delete positions for these buckets
        print("[RESET] Deleting bot_positions for these buckets...")
        cx.execute(
            f"DELETE FROM bot_positions WHERE bucket_id IN ({placeholders})",
            bucket_ids,
        )

        # 5) Delete bucket transfers (so net_deposit / drawdown resets)
        print("[RESET] Deleting bot_bucket_transfers for these buckets...")
        cx.execute(
            f"DELETE FROM bot_bucket_transfers WHERE bucket_id IN ({placeholders})",
            bucket_ids,
        )

        # 6) Zero out bucket allocations (cash_pi in DB)
        print("[RESET] Zeroing bot_bucket_allocations.amount for these buckets...")
        cx.execute(
            f"UPDATE bot_bucket_allocations SET amount = 0 WHERE bucket_id IN ({placeholders})",
            bucket_ids,
        )

        print("[RESET] Done. All state for @{TARGET_USERNAME} has been cleared.")
        print("Now re-deposit PI into the buckets via the UI and let the bot rebuild.")

if __name__ == "__main__":
    main()
