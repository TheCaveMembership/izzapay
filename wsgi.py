# wsgi.py
from werkzeug.middleware.dispatcher import DispatcherMiddleware
from app import app as izzapay_app
from game_app import app as izzagame_app

# Import the bot engine starter
from bot_engine import start_bot_in_background

# Mount IZZA GAME under /izza-game
application = DispatcherMiddleware(izzapay_app, {
    "/izza-game": izzagame_app,
})

# Start the trading bot in a background thread inside THIS process
try:
    start_bot_in_background()
except Exception as e:
    # Do not crash the app if the bot fails to start; just log.
    print(f"[WSGI] Failed to start bot background loop: {e}")
