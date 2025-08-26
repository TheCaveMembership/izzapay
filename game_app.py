# game_app.py
import os
from flask import Flask, render_template
from dotenv import load_dotenv

load_dotenv()

# Create a standalone Flask app for the game
app = Flask(__name__, template_folder="templates", static_folder="static")

# Read sandbox flag from .env (must match your main app)
PI_SANDBOX = os.getenv("PI_SANDBOX", "false").lower() == "true"


@app.route("/auth")
def game_auth():
    """
    Landing page for IZZA GAME authentication.
    Renders templates/game/auth.html
    """
    return render_template("game/auth.html", sandbox=PI_SANDBOX)
