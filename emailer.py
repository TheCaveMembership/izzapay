# emailer.py
import os, smtplib, ssl, sys
from email.message import EmailMessage

FROM_EMAIL = os.getenv("FROM_EMAIL", "no-reply@izzapay.shop")
SMTP_HOST  = os.getenv("SMTP_HOST", "")
SMTP_PORT  = int(os.getenv("SMTP_PORT", "587"))  # 587 = STARTTLS, 465 = SSL
SMTP_USER  = os.getenv("SMTP_USER", "")
SMTP_PASS  = os.getenv("SMTP_PASS", "")

def _smtp_client():
    if not SMTP_HOST:
        raise RuntimeError("SMTP_HOST not set")
    # SSL on 465, STARTTLS otherwise
    if SMTP_PORT == 465:
        ctx = ssl.create_default_context()
        server = smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=ctx, timeout=20)
    else:
        server = smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20)
        server.ehlo()
        try:
            server.starttls(context=ssl.create_default_context())
        except smtplib.SMTPException:
            # Some providers negotiate TLS automatically; continue
            pass
    if SMTP_USER:
        server.login(SMTP_USER, SMTP_PASS)
    return server

def send_email(to: str, subject: str, html: str):
    """
    Drop-in replacement. Returns True/False, but app.py doesn't need it.
    Writes detailed errors to stderr so you'll see them in logs.
    """
    if not to:
        print("send_email: missing recipient", file=sys.stderr)
        return False
    if not SMTP_HOST:
        print("send_email: SMTP not configured (set FROM_EMAIL, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS)", file=sys.stderr)
        return False

    try:
        # Build message with text fallback for better spam scoring
        msg = EmailMessage()
        msg["From"] = FROM_EMAIL
        msg["To"] = to
        msg["Subject"] = subject

        text_fallback = (html or "").replace("<br>", "\n").replace("<br/>", "\n")
        msg.set_content(text_fallback or " ")
        msg.add_alternative(html or "<p></p>", subtype="html")

        with _smtp_client() as s:
            s.send_message(msg)
        return True
    except Exception as e:
        print("send_email error:", repr(e), file=sys.stderr)
        return False
