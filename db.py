# db.py
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
    _ensure_dirs()
    cx = sqlite3.connect(DB_PATH, check_same_thread=False, detect_types=sqlite3.PARSE_DECLTYPES)
    cx.row_factory = sqlite3.Row
    cx.execute("PRAGMA foreign_keys=ON;")
    cx.execute("PRAGMA journal_mode=WAL;")
    cx.execute("PRAGMA synchronous=NORMAL;")
    cx.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS};")
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
          -- newer cols: pi_wallet_address, pi_handle, colorway (added later)
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

        ----------------------------------------------------------------------
        -- NEW: NFT / Collections (on-chain asset, off-chain serials)
        ----------------------------------------------------------------------

        CREATE TABLE IF NOT EXISTS nft_collections(
          id INTEGER PRIMARY KEY,
          merchant_id INTEGER,               -- who owns/controls the collection
          creator_user_id INTEGER,           -- original creator (for royalties, attribution)
          code TEXT NOT NULL,                -- asset code (<=12)
          issuer TEXT NOT NULL,              -- issuer account (usually your IZZA issuer)
          dist_account TEXT,                 -- optional: distribution account that holds supply
          name TEXT,
          description TEXT,
          image_url TEXT,                    -- primary card art
          metadata_json TEXT,                -- arbitrary JSON for traits
          total_supply INTEGER NOT NULL,     -- # of editions minted on-chain
          decimals INTEGER NOT NULL DEFAULT 0, -- keep 0 for NFTs
          status TEXT DEFAULT 'draft',       -- draft | published | archived
          locked_issuer INTEGER DEFAULT 0,   -- 1 if issuer locked after policy
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
          serial INTEGER NOT NULL,                 -- 1..N
          owner_user_id INTEGER,                   -- null if held by dist account
          owner_wallet_pub TEXT,                   -- convenience cache
          minted_at INTEGER,
          metadata_json TEXT,                      -- per-serial overrides (optional)
          UNIQUE(collection_id, serial),
          FOREIGN KEY(collection_id) REFERENCES nft_collections(id) ON DELETE CASCADE,
          FOREIGN KEY(owner_user_id) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_nft_tokens_owner ON nft_tokens(owner_user_id);

        CREATE TABLE IF NOT EXISTS nft_mint_events(
          id INTEGER PRIMARY KEY,
          collection_id INTEGER NOT NULL,
          minted_count INTEGER NOT NULL,          -- how many units minted in this op
          tx_hash TEXT,                           -- Horizon tx hash (Pi testnet)
          created_at INTEGER,
          FOREIGN KEY(collection_id) REFERENCES nft_collections(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS nft_listings(
          id INTEGER PRIMARY KEY,
          collection_id INTEGER NOT NULL,
          serial INTEGER,                         -- null => primary sale, allocate next
          seller_user_id INTEGER NOT NULL,        -- marketplace/dist for primary, user for resale
          price_pi REAL NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',  -- active | sold | canceled
          created_at INTEGER,
          sold_at INTEGER,
          buyer_user_id INTEGER,
          order_id INTEGER,                       -- link to orders row if routed through checkout
          FOREIGN KEY(collection_id) REFERENCES nft_collections(id) ON DELETE CASCADE,
          FOREIGN KEY(seller_user_id) REFERENCES users(id),
          FOREIGN KEY(buyer_user_id) REFERENCES users(id),
          FOREIGN KEY(order_id) REFERENCES orders(id)
        );
        CREATE INDEX IF NOT EXISTS idx_nft_listings_active ON nft_listings(collection_id, status);

        -- Pending NFT claims queue (for "claim like stake")
        CREATE TABLE IF NOT EXISTS nft_pending_claims(
          id INTEGER PRIMARY KEY,
          order_id INTEGER,              -- optional link to orders.id
          buyer_user_id INTEGER,         -- optional link to users.id
          buyer_username TEXT,
          buyer_pub TEXT NOT NULL,
          issuer TEXT NOT NULL,
          assets_json TEXT NOT NULL,     -- ["NFTABC001", "NFTABC002", ...]
          status TEXT NOT NULL DEFAULT 'pending',  -- pending | claimed | canceled
          created_at INTEGER NOT NULL,
          claimed_at INTEGER,
          UNIQUE(order_id)
        );
        CREATE INDEX IF NOT EXISTS idx_nft_pending_pub ON nft_pending_claims(buyer_pub, status);
        CREATE INDEX IF NOT EXISTS idx_nft_pending_user ON nft_pending_claims(buyer_username, status);
        """)

        # Partial UNIQUE indexes to replace the old FILTER syntax
        # One active listing per (collection_id, serial) for resale items
        cx.execute("""
          CREATE UNIQUE INDEX IF NOT EXISTS uniq_nft_listings_active_serial
          ON nft_listings(collection_id, serial)
          WHERE status='active' AND serial IS NOT NULL;
        """)
        # At most one active PRIMARY listing (serial is NULL) per collection
        cx.execute("""
          CREATE UNIQUE INDEX IF NOT EXISTS uniq_nft_listings_active_primary
          ON nft_listings(collection_id)
          WHERE status='active' AND serial IS NULL;
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

        # merchants.pi_wallet_address
        try: cx.execute("ALTER TABLE merchants ADD COLUMN pi_wallet_address TEXT")
        except Exception: pass

        # merchants.pi_handle
        try: cx.execute("ALTER TABLE merchants ADD COLUMN pi_handle TEXT")
        except Exception: pass

        # merchants.colorway
        try: cx.execute("ALTER TABLE merchants ADD COLUMN colorway TEXT")
        except Exception: pass

        # Create NFT tables if missing (safe to re-run)
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
          FOREIGN KEY(collection_id) REFERENCES nft_collections(id) ON DELETE CASCADE,
          FOREIGN KEY(seller_user_id) REFERENCES users(id),
          FOREIGN KEY(buyer_user_id) REFERENCES users(id),
          FOREIGN KEY(order_id) REFERENCES orders(id)
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
        """)

        # Recreate the partial UNIQUE indexes if needed
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
