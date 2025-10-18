# db.py
import os, sqlite3, threading

# --- Persistent locations (works on Render or locally) ---
DATA_ROOT = os.getenv("DATA_ROOT", "/var/data/izzapay")
DB_PATH   = os.getenv("SQLITE_DB_PATH", os.path.join(DATA_ROOT, "app.sqlite"))
BUSY_TIMEOUT_MS = int(os.getenv("SQLITE_BUSY_TIMEOUT_MS", "3000"))  # 3s default

_lock = threading.Lock()

def _ensure_dirs():
    # Make sure /var/data/izzapay exists (or whatever you set)
    try:
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    except Exception:
        pass

def conn():
    _ensure_dirs()
    # Allow use across threads if needed; each request should still open/close its own conn.
    cx = sqlite3.connect(DB_PATH, check_same_thread=False, detect_types=sqlite3.PARSE_DECLTYPES)
    cx.row_factory = sqlite3.Row
    # Sensible defaults for a web app on SQLite
    cx.execute("PRAGMA foreign_keys=ON;")
    cx.execute("PRAGMA journal_mode=WAL;")
    cx.execute("PRAGMA synchronous=NORMAL;")
    cx.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS};")
    return cx

def init_db():
    _ensure_dirs()
    with _lock, conn() as cx:
        cx.executescript("""
        -- Core tables
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
          -- Newer columns are added by ensure_schema() in app.py if missing:
          -- pi_wallet_address TEXT, pi_handle TEXT, colorway TEXT
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
          -- Newer columns are added by ensure_schema() in app.py if missing:
          -- pi_payment_id TEXT, cart_id TEXT, line_items_json TEXT, user_id INTEGER
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
          -- Newer columns are added by ensure_schema() in app.py if missing:
          -- buyer_user_id INTEGER, created_at INTEGER
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
        """)

def ensure_schema():
    """Add missing columns without dropping existing data."""
    with _lock, conn() as cx:
        # sessions.pi_username
        try:
            cx.execute("ALTER TABLE sessions ADD COLUMN pi_username TEXT")
        except Exception:
            pass  # already exists

        # sessions.checkout_path
        try:
            cx.execute("ALTER TABLE sessions ADD COLUMN checkout_path TEXT")
        except Exception:
            pass  # already exists
