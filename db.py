import os, sqlite3, threading

DATA_ROOT = os.getenv("DATA_ROOT", "/var/data/izzapay")
DB_PATH = os.getenv("SQLITE_DB_PATH", os.path.join(DATA_ROOT, "app.sqlite"))
BUSY_TIMEOUT_MS = int(os.getenv("SQLITE_BUSY_TIMEOUT_MS", "3000"))

_lock = threading.Lock()

def _ensure_dirs():
    try:
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    except Exception:
        pass

def conn():
    _ensure_dirs()
    cx = sqlite3.connect(DB_PATH, check_same_thread=False, detect_types=sqlite3.PARSE_DECLTYPES)
    cx.row_factory = sqlite3.Row

    try:
        cx.execute("PRAGMA journal_mode=DELETE;")
    except Exception as e:
        print("[DB] PRAGMA journal_mode=DELETE failed:", e)

    try:
        cx.execute("PRAGMA foreign_keys=ON;")
        cx.execute("PRAGMA synchronous=NORMAL;")
        cx.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS};")
    except Exception as e:
        print("[DB] PRAGMA error:", e)

    return cx

def _cols(cx, table):
    try:
        return {r["name"] for r in cx.execute(f"PRAGMA table_info({table})").fetchall()}
    except Exception:
        return set()

def _migrate_live_auction_wins(cx):
    """
    Fix old live_auction_wins schema that had:
      lot_id INTEGER NOT NULL UNIQUE

    SQLite cannot remove NOT NULL with ALTER TABLE, so we rebuild the table.
    """
    try:
        info = cx.execute("PRAGMA table_info(live_auction_wins)").fetchall()
        if not info:
            return

        bad_lot_id = any(
            r["name"] == "lot_id" and int(r["notnull"] or 0) == 1
            for r in info
        )

        cols = {r["name"] for r in info}

        missing_new_cols = any(c not in cols for c in (
            "user_id", "card_title", "card_description", "card_image_url",
            "status", "checkout_id"
        ))

        if not bad_lot_id and not missing_new_cols:
            return

        cx.execute("ALTER TABLE live_auction_wins RENAME TO live_auction_wins_old")

        cx.execute("""
            CREATE TABLE live_auction_wins(
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              auction_id INTEGER NOT NULL,
              user_id INTEGER,
              username TEXT NOT NULL,
              card_title TEXT,
              card_description TEXT,
              card_image_url TEXT,
              winning_bid_pi REAL DEFAULT 0,
              status TEXT NOT NULL DEFAULT 'won',
              checkout_id INTEGER,
              created_at INTEGER,
              updated_at INTEGER
            )
        """)

        old_cols = _cols(cx, "live_auction_wins_old")

        select_auction_id = "auction_id" if "auction_id" in old_cols else "0"
        select_user_id = "user_id" if "user_id" in old_cols else "NULL"
        select_username = "username" if "username" in old_cols else "'unknown'"
        select_card_title = "card_title" if "card_title" in old_cols else "'Auction win'"
        select_card_description = "card_description" if "card_description" in old_cols else "''"
        select_card_image_url = "card_image_url" if "card_image_url" in old_cols else "''"
        select_winning_bid_pi = "winning_bid_pi" if "winning_bid_pi" in old_cols else "0"
        select_status = "status" if "status" in old_cols else "'won'"
        select_checkout_id = "checkout_id" if "checkout_id" in old_cols else "NULL"
        select_created_at = "created_at" if "created_at" in old_cols else "strftime('%s','now')"
        select_updated_at = "updated_at" if "updated_at" in old_cols else "strftime('%s','now')"

        cx.execute(f"""
            INSERT INTO live_auction_wins(
              auction_id, user_id, username, card_title, card_description,
              card_image_url, winning_bid_pi, status, checkout_id, created_at, updated_at
            )
            SELECT
              {select_auction_id},
              {select_user_id},
              {select_username},
              COALESCE({select_card_title}, 'Auction win'),
              COALESCE({select_card_description}, ''),
              COALESCE({select_card_image_url}, ''),
              COALESCE({select_winning_bid_pi}, 0),
              COALESCE({select_status}, 'won'),
              {select_checkout_id},
              COALESCE({select_created_at}, strftime('%s','now')),
              COALESCE({select_updated_at}, strftime('%s','now'))
            FROM live_auction_wins_old
        """)

        cx.execute("DROP TABLE live_auction_wins_old")
        print("[DB] live_auction_wins migrated away from old lot_id schema")

    except Exception as e:
        print("[DB] live_auction_wins migration failed:", e)

def init_db():
    _ensure_dirs()
    with _lock, conn() as cx:
        cx.executescript("""
        CREATE TABLE IF NOT EXISTS users(
          id INTEGER PRIMARY KEY,
          pi_uid TEXT UNIQUE,
          pi_username TEXT,
          username TEXT,
          role TEXT DEFAULT 'buyer',
          created_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS merchants(
          id INTEGER PRIMARY KEY,
          owner_user_id INTEGER,
          slug TEXT UNIQUE,
          business_name TEXT,
          logo_url TEXT,
          theme_mode TEXT DEFAULT 'dark',
          reply_to_email TEXT,
          pi_wallet TEXT NOT NULL,
          description TEXT,
          banner_url TEXT,
          font_family TEXT,
          custom_css TEXT,
          pi_wallet_address TEXT,
          pi_handle TEXT,
          colorway TEXT,
          FOREIGN KEY(owner_user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS items(
          id INTEGER PRIMARY KEY,
          merchant_id INTEGER,
          link_id TEXT UNIQUE,
          title TEXT,
          sku TEXT,
          image_url TEXT,
          pi_price REAL,
          stock_qty INTEGER,
          allow_backorder INTEGER DEFAULT 0,
          active INTEGER DEFAULT 1,
          is_nft INTEGER DEFAULT 0,
          nft_kind TEXT,
          nft_size INTEGER,
          nft_prefix TEXT,
          nft_tag TEXT,
          nft_assets_json TEXT,
          nft_vault_json TEXT,
          nft_commission_bp INTEGER,
          claim_kind TEXT,
          meta_type TEXT,
          category TEXT,
          fulfillment_kind TEXT,
          crafted_item_id INTEGER,
          FOREIGN KEY(merchant_id) REFERENCES merchants(id)
        );

        CREATE TABLE IF NOT EXISTS sessions(
          id TEXT PRIMARY KEY,
          merchant_id INTEGER,
          item_id INTEGER,
          qty INTEGER,
          expected_pi REAL,
          state TEXT,
          created_at INTEGER,
          pi_tx_hash TEXT,
          FOREIGN KEY(merchant_id) REFERENCES merchants(id)
        );

        CREATE TABLE IF NOT EXISTS orders(
          id INTEGER PRIMARY KEY,
          merchant_id INTEGER,
          item_id INTEGER,
          qty INTEGER,
          buyer_email TEXT,
          buyer_name TEXT,
          shipping_json TEXT,
          pi_amount REAL,
          pi_fee REAL,
          pi_merchant_net REAL,
          pi_tx_hash TEXT UNIQUE,
          payout_status TEXT,
          status TEXT,
          tracking_carrier TEXT,
          tracking_number TEXT,
          tracking_url TEXT,
          buyer_token TEXT
        );

        CREATE TABLE IF NOT EXISTS fee_ledger(
          id INTEGER PRIMARY KEY,
          kind TEXT,
          amount REAL,
          tx_hash TEXT,
          created_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS collectible_claims(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          order_id INTEGER NOT NULL UNIQUE,
          user_id INTEGER NOT NULL,
          claimed_at INTEGER NOT NULL,
          FOREIGN KEY(order_id) REFERENCES orders(id)
        );

        CREATE TABLE IF NOT EXISTS user_wallets(
          id INTEGER PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          pub TEXT NOT NULL,
          created_at INTEGER,
          updated_at INTEGER
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_user_wallets_username ON user_wallets(username);

        CREATE TABLE IF NOT EXISTS izza_airdrop_wallets(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE,
          wallet_pub TEXT NOT NULL,
          created_at INTEGER,
          updated_at INTEGER
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_izza_airdrop_wallets_username
          ON izza_airdrop_wallets(username);

        CREATE TABLE IF NOT EXISTS warzone_invites(
          id INTEGER PRIMARY KEY,
          from_user_id INTEGER NOT NULL,
          to_user_id INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at INTEGER NOT NULL,
          responded_at INTEGER,
          FOREIGN KEY(from_user_id) REFERENCES users(id),
          FOREIGN KEY(to_user_id) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_warzone_invites_to_status
          ON warzone_invites(to_user_id, status);

        CREATE TABLE IF NOT EXISTS warzone_friends(
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL,
          friend_user_id INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE(user_id, friend_user_id),
          FOREIGN KEY(user_id) REFERENCES users(id),
          FOREIGN KEY(friend_user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS nft_collections(
          id INTEGER PRIMARY KEY,
          merchant_id INTEGER,
          creator_user_id INTEGER,
          code TEXT NOT NULL,
          issuer TEXT NOT NULL,
          dist_account TEXT,
          name TEXT,
          description TEXT,
          image_url TEXT,
          metadata_json TEXT,
          total_supply INTEGER NOT NULL,
          decimals INTEGER NOT NULL DEFAULT 0,
          status TEXT DEFAULT 'draft',
          locked_issuer INTEGER DEFAULT 0,
          royalty_bp INTEGER,
          backing_template_izza TEXT,
          created_at INTEGER,
          updated_at INTEGER,
          UNIQUE(code, issuer),
          FOREIGN KEY(merchant_id) REFERENCES merchants(id),
          FOREIGN KEY(creator_user_id) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_nft_collections_merchant ON nft_collections(merchant_id);
        CREATE INDEX IF NOT EXISTS idx_nft_collections_status ON nft_collections(status);

        CREATE TABLE IF NOT EXISTS nft_tokens(
          id INTEGER PRIMARY KEY,
          collection_id INTEGER NOT NULL,
          serial INTEGER NOT NULL,
          owner_user_id INTEGER,
          owner_wallet_pub TEXT,
          minted_at INTEGER,
          metadata_json TEXT,
          backing_izza TEXT,
          backing_asset_code TEXT,
          backing_asset_issuer TEXT,
          UNIQUE(collection_id, serial),
          FOREIGN KEY(collection_id) REFERENCES nft_collections(id) ON DELETE CASCADE,
          FOREIGN KEY(owner_user_id) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_nft_tokens_owner ON nft_tokens(owner_user_id);

        CREATE TABLE IF NOT EXISTS nft_mint_events(
          id INTEGER PRIMARY KEY,
          collection_id INTEGER NOT NULL,
          minted_count INTEGER NOT NULL,
          tx_hash TEXT,
          created_at INTEGER,
          FOREIGN KEY(collection_id) REFERENCES nft_collections(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS nft_listings(
          id INTEGER PRIMARY KEY,
          collection_id INTEGER NOT NULL,
          serial INTEGER,
          seller_user_id INTEGER NOT NULL,
          price_pi REAL NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER,
          sold_at INTEGER,
          buyer_user_id INTEGER,
          order_id INTEGER,
          item_id INTEGER,
          buyer_username TEXT,
          FOREIGN KEY(collection_id) REFERENCES nft_collections(id) ON DELETE CASCADE,
          FOREIGN KEY(seller_user_id) REFERENCES users(id),
          FOREIGN KEY(buyer_user_id) REFERENCES users(id),
          FOREIGN KEY(order_id) REFERENCES orders(id),
          FOREIGN KEY(item_id) REFERENCES items(id)
        );
        CREATE INDEX IF NOT EXISTS idx_nft_listings_active ON nft_listings(collection_id, status);

        CREATE TABLE IF NOT EXISTS nft_pending_claims(
          id INTEGER PRIMARY KEY,
          order_id INTEGER,
          buyer_user_id INTEGER,
          buyer_username TEXT,
          buyer_pub TEXT NOT NULL,
          issuer TEXT NOT NULL,
          assets_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at INTEGER NOT NULL,
          claimed_at INTEGER,
          UNIQUE(order_id)
        );
        CREATE INDEX IF NOT EXISTS idx_nft_pending_pub ON nft_pending_claims(buyer_pub, status);
        CREATE INDEX IF NOT EXISTS idx_nft_pending_user ON nft_pending_claims(buyer_username, status);

        CREATE TABLE IF NOT EXISTS live_auction_signups(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE,
          pi_uid TEXT,
          interest_one_piece INTEGER DEFAULT 0,
          interest_pokemon INTEGER DEFAULT 0,
          email TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_live_auction_signups_username
          ON live_auction_signups(username);

        CREATE TABLE IF NOT EXISTS live_auctions(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          merchant_id INTEGER NOT NULL,
          slug TEXT UNIQUE,
          title TEXT NOT NULL,
          description TEXT,
          tcg_type TEXT DEFAULT 'mixed',
          starts_at INTEGER,
          scheduled_length_minutes INTEGER DEFAULT 60,
          status TEXT NOT NULL DEFAULT 'draft',
          stream_status TEXT DEFAULT 'offline',
          stream_key TEXT,
          playback_url TEXT,
          created_by_username TEXT,
          image_url TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER,
          FOREIGN KEY(merchant_id) REFERENCES merchants(id)
        );
        CREATE INDEX IF NOT EXISTS idx_live_auctions_merchant_status
          ON live_auctions(merchant_id, status);
        CREATE INDEX IF NOT EXISTS idx_live_auctions_starts_at
          ON live_auctions(starts_at);

        CREATE TABLE IF NOT EXISTS live_auction_lots(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          auction_id INTEGER NOT NULL,
          lot_number INTEGER,
          title TEXT NOT NULL,
          description TEXT,
          image_url TEXT,
          starting_bid_pi REAL DEFAULT 0,
          bid_increment_pi REAL DEFAULT 0.01,
          status TEXT NOT NULL DEFAULT 'pending',
          winner_username TEXT,
          winning_bid_pi REAL,
          started_at INTEGER,
          ended_at INTEGER,
          created_at INTEGER NOT NULL,
          FOREIGN KEY(auction_id) REFERENCES live_auctions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_live_auction_lots_auction
          ON live_auction_lots(auction_id, lot_number, status);

        CREATE TABLE IF NOT EXISTS live_auction_bids(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          auction_id INTEGER NOT NULL,
          lot_id INTEGER,
          username TEXT NOT NULL,
          bid_pi REAL NOT NULL,
          source TEXT DEFAULT 'websocket',
          accepted INTEGER DEFAULT 1,
          created_at INTEGER NOT NULL,
          FOREIGN KEY(auction_id) REFERENCES live_auctions(id) ON DELETE CASCADE,
          FOREIGN KEY(lot_id) REFERENCES live_auction_lots(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_live_auction_bids_lot
          ON live_auction_bids(lot_id, bid_pi, created_at);
        CREATE INDEX IF NOT EXISTS idx_live_auction_bids_user
          ON live_auction_bids(username, auction_id);

        CREATE TABLE IF NOT EXISTS live_auction_wins(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          auction_id INTEGER NOT NULL,
          user_id INTEGER,
          username TEXT NOT NULL,
          card_title TEXT,
          card_description TEXT,
          card_image_url TEXT,
          winning_bid_pi REAL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'won',
          checkout_id INTEGER,
          created_at INTEGER,
          updated_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_live_auction_wins_auction_user
          ON live_auction_wins(auction_id, username);

        CREATE TABLE IF NOT EXISTS live_auction_checkouts(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          auction_id INTEGER NOT NULL,
          user_id INTEGER,
          username TEXT NOT NULL,
          merchant_id INTEGER,
          item_id INTEGER,
          link_id TEXT,
          total_pi REAL NOT NULL DEFAULT 0,
          wins_json TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'pending',
          created_at INTEGER,
          updated_at INTEGER,
          UNIQUE(auction_id, username)
        );
        CREATE INDEX IF NOT EXISTS idx_live_auction_checkouts_auction_user
          ON live_auction_checkouts(auction_id, username);

        CREATE TABLE IF NOT EXISTS live_auction_checkout_bundles(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          auction_id INTEGER NOT NULL,
          username TEXT NOT NULL,
          merchant_id INTEGER NOT NULL,
          item_id INTEGER,
          total_pi REAL NOT NULL DEFAULT 0,
          lots_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at INTEGER NOT NULL,
          updated_at INTEGER,
          UNIQUE(auction_id, username),
          FOREIGN KEY(auction_id) REFERENCES live_auctions(id) ON DELETE CASCADE,
          FOREIGN KEY(merchant_id) REFERENCES merchants(id),
          FOREIGN KEY(item_id) REFERENCES items(id)
        );
        CREATE INDEX IF NOT EXISTS idx_live_auction_bundles_user_status
          ON live_auction_checkout_bundles(username, status);

        CREATE TRIGGER IF NOT EXISTS trg_users_username_default_ins
        AFTER INSERT ON users
        WHEN NEW.username IS NULL
        BEGIN
          UPDATE users SET username = NEW.pi_username WHERE id = NEW.id;
        END;

        CREATE TRIGGER IF NOT EXISTS trg_users_username_default_upd
        AFTER UPDATE OF pi_username ON users
        WHEN NEW.username IS NULL
        BEGIN
          UPDATE users SET username = NEW.pi_username WHERE id = NEW.id;
        END;

        CREATE TABLE IF NOT EXISTS bot_accounts(
          id INTEGER PRIMARY KEY,
          username TEXT NOT NULL,
          wallet_pub TEXT NOT NULL,
          total_deposited REAL NOT NULL DEFAULT 0,
          total_withdrawn REAL NOT NULL DEFAULT 0,
          created_at INTEGER,
          updated_at INTEGER,
          UNIQUE(username, wallet_pub)
        );
        CREATE INDEX IF NOT EXISTS idx_bot_accounts_username ON bot_accounts(username);

        CREATE TABLE IF NOT EXISTS bot_buckets(
          id INTEGER PRIMARY KEY,
          account_id INTEGER NOT NULL,
          name TEXT,
          objective TEXT,
          risk_level TEXT,
          volatility TEXT,
          time_horizon_days INTEGER,
          target_value_back REAL,
          status TEXT NOT NULL DEFAULT 'active',
          paused_until INTEGER,
          liquidation_status TEXT,
          created_at INTEGER,
          updated_at INTEGER,
          FOREIGN KEY(account_id) REFERENCES bot_accounts(id)
        );
        CREATE INDEX IF NOT EXISTS idx_bot_buckets_account ON bot_buckets(account_id);

        CREATE TABLE IF NOT EXISTS bot_deposits(
          id INTEGER PRIMARY KEY,
          account_id INTEGER NOT NULL,
          tx_hash TEXT,
          amount REAL NOT NULL,
          asset_code TEXT,
          asset_issuer TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at INTEGER,
          raw_json TEXT,
          FOREIGN KEY(account_id) REFERENCES bot_accounts(id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_deposits_tx ON bot_deposits(tx_hash);

        CREATE TABLE IF NOT EXISTS bot_bucket_allocations(
          id INTEGER PRIMARY KEY,
          account_id INTEGER NOT NULL,
          bucket_id INTEGER NOT NULL,
          amount REAL NOT NULL DEFAULT 0,
          created_at INTEGER,
          updated_at INTEGER,
          FOREIGN KEY(account_id) REFERENCES bot_accounts(id),
          FOREIGN KEY(bucket_id) REFERENCES bot_buckets(id),
          UNIQUE(account_id, bucket_id)
        );
        CREATE INDEX IF NOT EXISTS idx_bot_alloc_account ON bot_bucket_allocations(account_id);

        CREATE TABLE IF NOT EXISTS bot_bucket_transfers(
          id INTEGER PRIMARY KEY,
          bucket_id INTEGER NOT NULL,
          direction TEXT NOT NULL CHECK (direction IN ('deposit','withdraw')),
          amount REAL NOT NULL,
          created_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS bot_withdrawals(
          id INTEGER PRIMARY KEY,
          account_id INTEGER NOT NULL,
          amount REAL NOT NULL,
          status TEXT NOT NULL DEFAULT 'requested',
          dest_pub TEXT,
          created_at INTEGER,
          txid TEXT,
          raw_json TEXT,
          FOREIGN KEY(account_id) REFERENCES bot_accounts(id)
        );
        CREATE INDEX IF NOT EXISTS idx_bot_withdrawals_account ON bot_withdrawals(account_id);

        CREATE TABLE IF NOT EXISTS bot_bucket_snapshots(
          id INTEGER PRIMARY KEY,
          bucket_id INTEGER NOT NULL,
          ts INTEGER NOT NULL,
          total_value REAL NOT NULL,
          notes TEXT,
          FOREIGN KEY(bucket_id) REFERENCES bot_buckets(id)
        );
        CREATE INDEX IF NOT EXISTS idx_bot_snapshots_bucket_ts ON bot_bucket_snapshots(bucket_id, ts);

        CREATE TABLE IF NOT EXISTS bot_trades(
          id INTEGER PRIMARY KEY,
          account_id INTEGER NOT NULL,
          bucket_id INTEGER NOT NULL,
          market_code TEXT,
          base_code TEXT,
          base_issuer TEXT,
          counter_code TEXT,
          counter_issuer TEXT,
          side TEXT,
          amount REAL,
          price REAL,
          value_pi REAL,
          amount_pi REAL,
          pnl_pi REAL,
          status TEXT,
          created_at INTEGER,
          ts INTEGER,
          raw_json TEXT,
          FOREIGN KEY(account_id) REFERENCES bot_accounts(id),
          FOREIGN KEY(bucket_id) REFERENCES bot_buckets(id)
        );
        CREATE INDEX IF NOT EXISTS idx_bot_trades_bucket_ts ON bot_trades(bucket_id, ts);
        """)

        _migrate_live_auction_wins(cx)

        cx.execute("""
          CREATE UNIQUE INDEX IF NOT EXISTS uniq_nft_listings_active_serial
          ON nft_listings(collection_id, serial)
          WHERE status='active' AND serial IS NOT NULL;
        """)
        cx.execute("""
          CREATE UNIQUE INDEX IF NOT EXISTS uniq_nft_listings_active_primary
          ON nft_listings(collection_id)
          WHERE status='active' AND serial IS NULL;
        """)

def ensure_schema():
    with _lock, conn() as cx:
        for sql in [
            "ALTER TABLE sessions ADD COLUMN pi_username TEXT",
            "ALTER TABLE sessions ADD COLUMN checkout_path TEXT",
            "ALTER TABLE sessions ADD COLUMN pi_payment_id TEXT",
            "ALTER TABLE sessions ADD COLUMN cart_id TEXT",
            "ALTER TABLE sessions ADD COLUMN line_items_json TEXT",
            "ALTER TABLE sessions ADD COLUMN user_id INTEGER",
            "ALTER TABLE orders ADD COLUMN buyer_user_id INTEGER",
            "ALTER TABLE orders ADD COLUMN created_at INTEGER",
            "ALTER TABLE users ADD COLUMN username TEXT",
            "ALTER TABLE merchants ADD COLUMN pi_wallet_address TEXT",
            "ALTER TABLE merchants ADD COLUMN pi_handle TEXT",
            "ALTER TABLE merchants ADD COLUMN colorway TEXT",
            "ALTER TABLE merchants ADD COLUMN description TEXT",
            "ALTER TABLE merchants ADD COLUMN banner_url TEXT",
            "ALTER TABLE merchants ADD COLUMN font_family TEXT",
            "ALTER TABLE merchants ADD COLUMN custom_css TEXT",
            "ALTER TABLE items ADD COLUMN is_nft INTEGER DEFAULT 0",
            "ALTER TABLE items ADD COLUMN nft_kind TEXT",
            "ALTER TABLE items ADD COLUMN nft_size INTEGER",
            "ALTER TABLE items ADD COLUMN nft_prefix TEXT",
            "ALTER TABLE items ADD COLUMN nft_tag TEXT",
            "ALTER TABLE items ADD COLUMN nft_assets_json TEXT",
            "ALTER TABLE items ADD COLUMN nft_vault_json TEXT",
            "ALTER TABLE items ADD COLUMN nft_commission_bp INTEGER",
            "ALTER TABLE items ADD COLUMN claim_kind TEXT",
            "ALTER TABLE items ADD COLUMN meta_type TEXT",
            "ALTER TABLE items ADD COLUMN category TEXT",
            "ALTER TABLE items ADD COLUMN fulfillment_kind TEXT",
            "ALTER TABLE items ADD COLUMN crafted_item_id INTEGER",
            "ALTER TABLE items ADD COLUMN svg_code TEXT",
            "ALTER TABLE nft_collections ADD COLUMN royalty_bp INTEGER",
            "ALTER TABLE nft_collections ADD COLUMN backing_template_izza TEXT",
            "ALTER TABLE nft_tokens ADD COLUMN backing_izza TEXT",
            "ALTER TABLE nft_tokens ADD COLUMN backing_asset_code TEXT",
            "ALTER TABLE nft_tokens ADD COLUMN backing_asset_issuer TEXT",
            "ALTER TABLE nft_listings ADD COLUMN item_id INTEGER",
            "ALTER TABLE nft_listings ADD COLUMN buyer_username TEXT",
            "ALTER TABLE bot_trades ADD COLUMN amount_pi REAL",
            "ALTER TABLE bot_trades ADD COLUMN created_at INTEGER",
            "ALTER TABLE bot_buckets ADD COLUMN paused_until INTEGER",
            "ALTER TABLE bot_buckets ADD COLUMN liquidation_status TEXT",
            "ALTER TABLE live_auctions ADD COLUMN image_url TEXT",
            "ALTER TABLE live_auctions ADD COLUMN playback_url TEXT",
            "ALTER TABLE live_auctions ADD COLUMN stream_status TEXT DEFAULT 'offline'",
            "ALTER TABLE live_auctions ADD COLUMN created_by_username TEXT",
            "ALTER TABLE live_auction_wins ADD COLUMN user_id INTEGER",
            "ALTER TABLE live_auction_wins ADD COLUMN card_title TEXT",
            "ALTER TABLE live_auction_wins ADD COLUMN card_description TEXT",
            "ALTER TABLE live_auction_wins ADD COLUMN card_image_url TEXT",
            "ALTER TABLE live_auction_wins ADD COLUMN winning_bid_pi REAL DEFAULT 0",
            "ALTER TABLE live_auction_wins ADD COLUMN status TEXT DEFAULT 'won'",
            "ALTER TABLE live_auction_wins ADD COLUMN checkout_id INTEGER",
            "ALTER TABLE live_auction_wins ADD COLUMN updated_at INTEGER",
            "ALTER TABLE live_auction_checkouts ADD COLUMN user_id INTEGER",
            "ALTER TABLE live_auction_checkouts ADD COLUMN merchant_id INTEGER",
            "ALTER TABLE live_auction_checkouts ADD COLUMN item_id INTEGER",
            "ALTER TABLE live_auction_checkouts ADD COLUMN link_id TEXT",
            "ALTER TABLE live_auction_checkouts ADD COLUMN total_pi REAL DEFAULT 0",
            "ALTER TABLE live_auction_checkouts ADD COLUMN wins_json TEXT DEFAULT '[]'",
            "ALTER TABLE live_auction_checkouts ADD COLUMN status TEXT DEFAULT 'pending'",
            "ALTER TABLE live_auction_checkouts ADD COLUMN created_at INTEGER",
            "ALTER TABLE live_auction_checkouts ADD COLUMN updated_at INTEGER",
        ]:
            try:
                cx.execute(sql)
            except Exception:
                pass

        _migrate_live_auction_wins(cx)

        cx.executescript("""
        CREATE TABLE IF NOT EXISTS izza_airdrop_wallets(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE,
          wallet_pub TEXT NOT NULL,
          created_at INTEGER,
          updated_at INTEGER
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_izza_airdrop_wallets_username
          ON izza_airdrop_wallets(username);

        CREATE INDEX IF NOT EXISTS idx_nft_listings_item_active
          ON nft_listings(item_id, status);

        CREATE UNIQUE INDEX IF NOT EXISTS uniq_nft_listings_active_serial
          ON nft_listings(collection_id, serial)
          WHERE status='active' AND serial IS NOT NULL;

        CREATE UNIQUE INDEX IF NOT EXISTS uniq_nft_listings_active_primary
          ON nft_listings(collection_id)
          WHERE status='active' AND serial IS NULL;

        CREATE INDEX IF NOT EXISTS idx_live_auction_wins_auction_user
          ON live_auction_wins(auction_id, username);

        CREATE INDEX IF NOT EXISTS idx_live_auction_checkouts_auction_user
          ON live_auction_checkouts(auction_id, username);

        CREATE TRIGGER IF NOT EXISTS trg_users_username_default_ins
        AFTER INSERT ON users
        WHEN NEW.username IS NULL
        BEGIN
          UPDATE users SET username = NEW.pi_username WHERE id = NEW.id;
        END;

        CREATE TRIGGER IF NOT EXISTS trg_users_username_default_upd
        AFTER UPDATE OF pi_username ON users
        WHEN NEW.username IS NULL
        BEGIN
          UPDATE users SET username = NEW.pi_username WHERE id = NEW.id;
        END;
        """)
