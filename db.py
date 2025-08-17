import sqlite3, os, threading
DB_PATH = os.path.join(os.path.dirname(__file__), "app.sqlite3")
_lock = threading.Lock()

def conn():
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    return c

def init_db():
    with _lock, conn() as cx:
        cx.executescript("""
        PRAGMA journal_mode=WAL;

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
          pi_tx_hash TEXT
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
          kind TEXT,      -- accrual | withdrawal
          amount REAL,
          tx_hash TEXT,
          created_at INTEGER
        );
        """)
