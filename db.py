import os, sqlite3, threading

# --- Persistent locations (works on Render or locally) ---
DATA_ROOT = os.getenv("DATA_ROOT", "/var/data/izzapay")
DB_PATH   = os.getenv("SQLITE_DB_PATH", os.path.join(DATA_ROOT, "app.sqlite"))
BUSY_TIMEOUT_MS = int(os.getenv("SQLITE_BUSY_TIMEOUT_MS", "3000"))  # 3s default

_lock = threading.Lock()

def _ensure_dirs():
    try:
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    except Exception:
        pass

def conn():
    """
    Open a SQLite connection to the persistent app.sqlite file.

    Small but important bit:
      - We *try* to force journal_mode=DELETE (simple rollback journal)
        which is safer on Render's network disk than WAL.
      - If the DB is busy or the PRAGMA fails, we log it and keep going.
        Your data and schema stay intact either way.
    """
    _ensure_dirs()
    cx = sqlite3.connect(
        DB_PATH,
        check_same_thread=False,
        detect_types=sqlite3.PARSE_DECLTYPES,
    )
    cx.row_factory = sqlite3.Row

    # Try to switch away from WAL to a simple rollback journal.
    # This does NOT drop data; it only changes how SQLite writes to disk.
    try:
        cx.execute("PRAGMA journal_mode=DELETE;")
    except Exception as e:
        # If another process has the DB locked, or Render glitches,
        # we don't crash the app – we just log it.
        print("[DB] PRAGMA journal_mode=DELETE failed:", e)

    # Other safe PRAGMAs
    try:
        cx.execute("PRAGMA foreign_keys=ON;")
        cx.execute("PRAGMA synchronous=NORMAL;")
        cx.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS};")
    except Exception as e:
        print("[DB] PRAGMA error:", e)

    return cx

def init_db():
    _ensure_dirs()
    with _lock, conn() as cx:
        cx.executescript("""
        -- Core tables (existing)
        CREATE TABLE IF NOT EXISTS users(
          id INTEGER PRIMARY KEY,
          pi_uid TEXT UNIQUE,
          pi_username TEXT,
          -- NEW: app code reads users.username
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

          -- Extended merchant presentation + Pi metadata
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

          -- NFT product configuration fields
          is_nft INTEGER DEFAULT 0,
          nft_kind TEXT,
          nft_size INTEGER,
          nft_prefix TEXT,
          nft_tag TEXT,
          nft_assets_json TEXT,
          nft_vault_json TEXT,
          nft_commission_bp INTEGER,
          claim_kind TEXT,

          -- Optional type/category metadata for templates
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
          -- newer cols: pi_payment_id, cart_id, line_items_json, user_id
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
          -- newer cols: buyer_user_id, created_at
        );

        CREATE TABLE IF NOT EXISTS fee_ledger(
          id INTEGER PRIMARY KEY,
          kind TEXT,      -- accrual | withdrawal
          amount REAL,
          tx_hash TEXT,
          created_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS collectible_claims(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          order_id INTEGER NOT NULL UNIQUE,
          user_id  INTEGER NOT NULL,
          claimed_at INTEGER NOT NULL,
          FOREIGN KEY(order_id) REFERENCES orders(id)
        );

        -- Wallet map (one active wallet per user)
        CREATE TABLE IF NOT EXISTS user_wallets (
          id INTEGER PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          pub TEXT NOT NULL,
          created_at INTEGER,
          updated_at INTEGER
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_user_wallets_username ON user_wallets(username);

        -- NEW: separate Pi Testnet airdrop wallet per username (used by /izza-airdrop)
        CREATE TABLE IF NOT EXISTS izza_airdrop_wallets(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username   TEXT NOT NULL UNIQUE,
          wallet_pub TEXT NOT NULL,
          created_at INTEGER,
          updated_at INTEGER
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_izza_airdrop_wallets_username
          ON izza_airdrop_wallets(username);

        ----------------------------------------------------------------------
        -- IZZA WAR ZONE friends + lobby invites
        ----------------------------------------------------------------------
        CREATE TABLE IF NOT EXISTS warzone_invites(
          id INTEGER PRIMARY KEY,
          from_user_id INTEGER NOT NULL,
          to_user_id   INTEGER NOT NULL,
          status       TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | declined
          created_at   INTEGER NOT NULL,
          responded_at INTEGER,
          FOREIGN KEY(from_user_id) REFERENCES users(id),
          FOREIGN KEY(to_user_id)   REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_warzone_invites_to_status
          ON warzone_invites(to_user_id, status);

        CREATE TABLE IF NOT EXISTS warzone_friends(
          id INTEGER PRIMARY KEY,
          user_id        INTEGER NOT NULL,
          friend_user_id INTEGER NOT NULL,
          created_at     INTEGER NOT NULL,
          UNIQUE(user_id, friend_user_id),
          FOREIGN KEY(user_id)        REFERENCES users(id),
          FOREIGN KEY(friend_user_id) REFERENCES users(id)
        );

        ----------------------------------------------------------------------
        -- NFT / Collections
        ----------------------------------------------------------------------

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
          -- NEW: value-backed + royalties
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
          -- NEW: vault backing per-token
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
          -- NEW: columns we need for SOLD + auditing
          item_id INTEGER,
          buyer_username TEXT,
          FOREIGN KEY(collection_id) REFERENCES nft_collections(id) ON DELETE CASCADE,
          FOREIGN KEY(seller_user_id) REFERENCES users(id),
          FOREIGN KEY(buyer_user_id) REFERENCES users(id),
          FOREIGN KEY(order_id) REFERENCES orders(id),
          FOREIGN KEY(item_id) REFERENCES items(id)
        );
        CREATE INDEX IF NOT EXISTS idx_nft_listings_active ON nft_listings(collection_id, status);

        -- Pending NFT claims queue
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
                ----------------------------------------------------------------------
        -- IZZA LIVE VIDEO AUCTIONS
        -- Exclusive merchant slug: /store/izza-game-crafting
        ----------------------------------------------------------------------

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
          lot_id INTEGER NOT NULL,
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
          lot_id INTEGER NOT NULL UNIQUE,
          username TEXT NOT NULL,
          winning_bid_pi REAL NOT NULL,
          bundled_item_id INTEGER,
          order_id INTEGER,
          checkout_status TEXT DEFAULT 'pending',
          created_at INTEGER NOT NULL,
          updated_at INTEGER,
          FOREIGN KEY(auction_id) REFERENCES live_auctions(id) ON DELETE CASCADE,
          FOREIGN KEY(lot_id) REFERENCES live_auction_lots(id),
          FOREIGN KEY(bundled_item_id) REFERENCES items(id),
          FOREIGN KEY(order_id) REFERENCES orders(id)
        );
        CREATE INDEX IF NOT EXISTS idx_live_auction_wins_user_status
          ON live_auction_wins(username, checkout_status);

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
        """)

        # Partial UNIQUE indexes for active listings
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

        # Keep users.username in sync with pi_username if username not provided
        cx.executescript("""
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

        # ------------------------------------------------------------------
        # IZZA BOT trading tables
        # ------------------------------------------------------------------
        cx.executescript("""
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
        CREATE INDEX IF NOT EXISTS idx_bot_accounts_username
          ON bot_accounts(username);

        CREATE TABLE IF NOT EXISTS bot_buckets(
          id INTEGER PRIMARY KEY,
          account_id INTEGER NOT NULL,
          name TEXT,
          objective TEXT,
          risk_level TEXT,
          volatility TEXT,
          time_horizon_days INTEGER,
          target_value_back REAL,
          status TEXT NOT NULL DEFAULT 'active', -- active | paused | closed
          paused_until INTEGER,                  -- NEW: pause window timestamp
          liquidation_status TEXT,              -- NEW: queued | in_progress | done
          created_at INTEGER,
          updated_at INTEGER,
          FOREIGN KEY(account_id) REFERENCES bot_accounts(id)
        );
        CREATE INDEX IF NOT EXISTS idx_bot_buckets_account
          ON bot_buckets(account_id);

        CREATE TABLE IF NOT EXISTS bot_deposits(
          id INTEGER PRIMARY KEY,
          account_id INTEGER NOT NULL,
          tx_hash TEXT,
          amount REAL NOT NULL,
          asset_code TEXT,
          asset_issuer TEXT,
          status TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | ignored
          created_at INTEGER,
          raw_json TEXT,
          FOREIGN KEY(account_id) REFERENCES bot_accounts(id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_deposits_tx
          ON bot_deposits(tx_hash);

        -- Current allocation per bucket for each account
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
        CREATE INDEX IF NOT EXISTS idx_bot_alloc_account
          ON bot_bucket_allocations(account_id);

        -- NEW: net deposit / withdrawal history per bucket (for drawdown calc)
        CREATE TABLE IF NOT EXISTS bot_bucket_transfers (
          id INTEGER PRIMARY KEY,
          bucket_id   INTEGER NOT NULL,
          direction   TEXT    NOT NULL CHECK (direction IN ('deposit','withdraw')),
          amount      REAL    NOT NULL,
          created_at  INTEGER
        );

        -- Optional: withdrawal requests (for later payout logic)
        CREATE TABLE IF NOT EXISTS bot_withdrawals(
          id INTEGER PRIMARY KEY,
          account_id INTEGER NOT NULL,
          amount REAL NOT NULL,
          status TEXT NOT NULL DEFAULT 'requested', -- requested | sent | failed
          dest_pub TEXT,
          created_at INTEGER,
          txid TEXT,
          raw_json TEXT,
          FOREIGN KEY(account_id) REFERENCES bot_accounts(id)
        );
        CREATE INDEX IF NOT EXISTS idx_bot_withdrawals_account
          ON bot_withdrawals(account_id);

        CREATE TABLE IF NOT EXISTS bot_bucket_snapshots(
          id INTEGER PRIMARY KEY,
          bucket_id INTEGER NOT NULL,
          ts INTEGER NOT NULL,
          total_value REAL NOT NULL,
          notes TEXT,
          FOREIGN KEY(bucket_id) REFERENCES bot_buckets(id)
        );
        CREATE INDEX IF NOT EXISTS idx_bot_snapshots_bucket_ts
          ON bot_bucket_snapshots(bucket_id, ts);

        -- NEW: per-trade ledger for each bucket/account
        CREATE TABLE IF NOT EXISTS bot_trades(
          id INTEGER PRIMARY KEY,
          account_id INTEGER NOT NULL,
          bucket_id INTEGER NOT NULL,
          market_code TEXT,
          base_code TEXT,
          base_issuer TEXT,
          counter_code TEXT,
          counter_issuer TEXT,
          side TEXT,              -- buy / sell
          amount REAL,            -- base amount
          price REAL,             -- price in counter
          value_pi REAL,          -- approximate value in PI
          amount_pi REAL,         -- PI amount used in trading_summary
          pnl_pi REAL,            -- realized PnL in PI (optional)
          status TEXT,            -- filled / partial / cancelled
          created_at INTEGER,     -- for trading_summary ordering
          ts INTEGER,             -- trade timestamp
          raw_json TEXT,
          FOREIGN KEY(account_id) REFERENCES bot_accounts(id),
          FOREIGN KEY(bucket_id) REFERENCES bot_buckets(id)
        );
        CREATE INDEX IF NOT EXISTS idx_bot_trades_bucket_ts
          ON bot_trades(bucket_id, ts);
        """)

def ensure_schema():
    """Add missing columns without dropping existing data; create new NFT tables if absent."""
    with _lock, conn() as cx:
        # sessions.pi_username
        try: cx.execute("ALTER TABLE sessions ADD COLUMN pi_username TEXT")
        except Exception: pass

        # sessions.checkout_path
        try: cx.execute("ALTER TABLE sessions ADD COLUMN checkout_path TEXT")
        except Exception: pass

        # orders.buyer_user_id
        try: cx.execute("ALTER TABLE orders ADD COLUMN buyer_user_id INTEGER")
        except Exception: pass

        # orders.created_at
        try: cx.execute("ALTER TABLE orders ADD COLUMN created_at INTEGER")
        except Exception: pass

        # merchants extras (safe if they already exist)
        try: cx.execute("ALTER TABLE merchants ADD COLUMN pi_wallet_address TEXT")
        except Exception: pass
        try: cx.execute("ALTER TABLE merchants ADD COLUMN pi_handle TEXT")
        except Exception: pass
        try: cx.execute("ALTER TABLE merchants ADD COLUMN colorway TEXT")
        except Exception: pass
        try: cx.execute("ALTER TABLE merchants ADD COLUMN description TEXT")
        except Exception: pass
        try: cx.execute("ALTER TABLE merchants ADD COLUMN banner_url TEXT")
        except Exception: pass
        try: cx.execute("ALTER TABLE merchants ADD COLUMN font_family TEXT")
        except Exception: pass
        try: cx.execute("ALTER TABLE merchants ADD COLUMN custom_css TEXT")
        except Exception: pass

        # items: NFT product flags and templates
        try: cx.execute("ALTER TABLE items ADD COLUMN is_nft INTEGER DEFAULT 0")
        except Exception: pass
        try: cx.execute("ALTER TABLE items ADD COLUMN nft_kind TEXT")
        except Exception: pass
        try: cx.execute("ALTER TABLE items ADD COLUMN nft_size INTEGER")
        except Exception: pass
        try: cx.execute("ALTER TABLE items ADD COLUMN nft_prefix TEXT")
        except Exception: pass
        try: cx.execute("ALTER TABLE items ADD COLUMN nft_tag TEXT")
        except Exception: pass
        try: cx.execute("ALTER TABLE items ADD COLUMN nft_assets_json TEXT")
        except Exception: pass
        try: cx.execute("ALTER TABLE items ADD COLUMN nft_vault_json TEXT")
        except Exception: pass
        try: cx.execute("ALTER TABLE items ADD COLUMN nft_commission_bp INTEGER")
        except Exception: pass
        try: cx.execute("ALTER TABLE items ADD COLUMN claim_kind TEXT")
        except Exception: pass
        try: cx.execute("ALTER TABLE items ADD COLUMN meta_type TEXT")
        except Exception: pass
        try: cx.execute("ALTER TABLE items ADD COLUMN category TEXT")
        except Exception: pass
        try: cx.execute("ALTER TABLE items ADD COLUMN fulfillment_kind TEXT")
        except Exception: pass
        try: cx.execute("ALTER TABLE items ADD COLUMN crafted_item_id INTEGER")
        except Exception: pass

        # NEW: additive columns for value-backed NFTs and royalties
        try: cx.execute("ALTER TABLE nft_collections ADD COLUMN royalty_bp INTEGER")
        except Exception: pass
        try: cx.execute("ALTER TABLE nft_collections ADD COLUMN backing_template_izza TEXT")
        except Exception: pass
        try: cx.execute("ALTER TABLE nft_tokens ADD COLUMN backing_izza TEXT")
        except Exception: pass
        try: cx.execute("ALTER TABLE nft_tokens ADD COLUMN backing_asset_code TEXT")
        except Exception: pass
        try: cx.execute("ALTER TABLE nft_tokens ADD COLUMN backing_asset_issuer TEXT")
        except Exception: pass

        # NFT tables (safe to re-run)
        cx.executescript("""
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

        ----------------------------------------------------------------------
        -- IZZA WAR ZONE friends + lobby invites
        ----------------------------------------------------------------------
        CREATE TABLE IF NOT EXISTS warzone_invites(
          id INTEGER PRIMARY KEY,
          from_user_id INTEGER NOT NULL,
          to_user_id   INTEGER NOT NULL,
          status       TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | declined
          created_at   INTEGER NOT NULL,
          responded_at INTEGER,
          FOREIGN KEY(from_user_id) REFERENCES users(id),
          FOREIGN KEY(to_user_id)   REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_warzone_invites_to_status
          ON warzone_invites(to_user_id, status);

        CREATE TABLE IF NOT EXISTS warzone_friends(
          id INTEGER PRIMARY KEY,
          user_id        INTEGER NOT NULL,
          friend_user_id INTEGER NOT NULL,
          created_at     INTEGER NOT NULL,
          UNIQUE(user_id, friend_user_id),
          FOREIGN KEY(user_id)        REFERENCES users(id),
          FOREIGN KEY(friend_user_id) REFERENCES users(id)
        );
        """)

        # Partial UNIQUE indexes (recreate if needed)
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

        # Additive column migrations for existing DBs
        try: cx.execute("ALTER TABLE users ADD COLUMN username TEXT")
        except Exception: pass
        try: cx.execute("ALTER TABLE nft_listings ADD COLUMN item_id INTEGER")
        except Exception: pass
        try: cx.execute("ALTER TABLE nft_listings ADD COLUMN buyer_username TEXT")
        except Exception: pass

        # NEW: ensure izza_airdrop_wallets exists in migrated DBs too
        try:
            cx.execute("""
              CREATE TABLE IF NOT EXISTS izza_airdrop_wallets(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username   TEXT NOT NULL UNIQUE,
                wallet_pub TEXT NOT NULL,
                created_at INTEGER,
                updated_at INTEGER
              );
            """)
            cx.execute("""
              CREATE UNIQUE INDEX IF NOT EXISTS idx_izza_airdrop_wallets_username
              ON izza_airdrop_wallets(username);
            """)
        except Exception:
            pass

        # Now that item_id exists, create the lookup index safely
        try:
            cx.execute("""
              CREATE INDEX IF NOT EXISTS idx_nft_listings_item_active
              ON nft_listings(item_id, status);
            """)
        except Exception:
            pass

        # Triggers to mirror pi_username -> username if username not set
        cx.executescript("""
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

                # ------------------------------------------------------------------
        # IZZA LIVE VIDEO AUCTIONS schema
        # Safe additive migration only
        # ------------------------------------------------------------------
        cx.executescript("""
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
          lot_id INTEGER NOT NULL,
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
          lot_id INTEGER NOT NULL UNIQUE,
          username TEXT NOT NULL,
          winning_bid_pi REAL NOT NULL,
          bundled_item_id INTEGER,
          order_id INTEGER,
          checkout_status TEXT DEFAULT 'pending',
          created_at INTEGER NOT NULL,
          updated_at INTEGER,
          FOREIGN KEY(auction_id) REFERENCES live_auctions(id) ON DELETE CASCADE,
          FOREIGN KEY(lot_id) REFERENCES live_auction_lots(id),
          FOREIGN KEY(bundled_item_id) REFERENCES items(id),
          FOREIGN KEY(order_id) REFERENCES orders(id)
        );
        CREATE INDEX IF NOT EXISTS idx_live_auction_wins_user_status
          ON live_auction_wins(username, checkout_status);

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
        """)

        # ------------------------------------------------------------------
        # IZZA BOT trading tables (safe for existing DBs)
        # ------------------------------------------------------------------
        cx.executescript("""
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
        CREATE INDEX IF NOT EXISTS idx_bot_accounts_username
          ON bot_accounts(username);

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
          paused_until INTEGER,          -- NEW in ensure_schema
          liquidation_status TEXT,      -- NEW in ensure_schema
          created_at INTEGER,
          updated_at INTEGER,
          FOREIGN KEY(account_id) REFERENCES bot_accounts(id)
        );
        CREATE INDEX IF NOT EXISTS idx_bot_buckets_account
          ON bot_buckets(account_id);

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
        CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_deposits_tx
          ON bot_deposits(tx_hash);

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
        CREATE INDEX IF NOT EXISTS idx_bot_alloc_account
          ON bot_bucket_allocations(account_id);

        -- NEW: net deposit / withdrawal history per bucket (for drawdown calc)
        CREATE TABLE IF NOT EXISTS bot_bucket_transfers (
          id INTEGER PRIMARY KEY,
          bucket_id   INTEGER NOT NULL,
          direction   TEXT    NOT NULL CHECK (direction IN ('deposit','withdraw')),
          amount      REAL    NOT NULL,
          created_at  INTEGER
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
        CREATE INDEX IF NOT EXISTS idx_bot_withdrawals_account
          ON bot_withdrawals(account_id);

        CREATE TABLE IF NOT EXISTS bot_bucket_snapshots(
          id INTEGER PRIMARY KEY,
          bucket_id INTEGER NOT NULL,
          ts INTEGER NOT NULL,
          total_value REAL NOT NULL,
          notes TEXT,
          FOREIGN KEY(bucket_id) REFERENCES bot_buckets(id)
        );
        CREATE INDEX IF NOT EXISTS idx_bot_snapshots_bucket_ts
          ON bot_bucket_snapshots(bucket_id, ts);

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
        CREATE INDEX IF NOT EXISTS idx_bot_trades_bucket_ts
          ON bot_trades(bucket_id, ts);
        """)

        # Ensure new columns exist on existing bot_trades table
        try:
            cx.execute("ALTER TABLE bot_trades ADD COLUMN amount_pi REAL")
        except Exception:
            pass
        try:
            cx.execute("ALTER TABLE bot_trades ADD COLUMN created_at INTEGER")
        except Exception:
            pass

        # NEW: ensure bot_buckets has paused_until + liquidation_status on older DBs
        try:
            cx.execute("ALTER TABLE bot_buckets ADD COLUMN paused_until INTEGER")
        except Exception:
            pass
        try:
            cx.execute("ALTER TABLE bot_buckets ADD COLUMN liquidation_status TEXT")
        except Exception:
            pass
