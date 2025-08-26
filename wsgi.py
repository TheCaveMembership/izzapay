# wsgi.py
from werkzeug.middleware.dispatcher import DispatcherMiddleware
from app import app as izzapay_app
from game_app import app as izzagame_app

# Mount IZZA GAME under /izza-game
application = DispatcherMiddleware(izzapay_app, {
    "/izza-game": izzagame_app
})
