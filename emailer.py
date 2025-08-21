# emailer.py
import os, smtplib, ssl, sys
from email.message import EmailMessage

SMTP_HOST  = os.getenv("SMTP_HOST", "")                 # e.g. smtp.gmail.com
SMTP_PORT  = int(os.getenv("SMTP_PORT", "587"))         # 587 STARTTLS, 465 SSL
SMTP_USER  = os.getenv("SMTP_USER", "")                 # e.g. info@izzapay.shop
SMTP_PASS  = (os.getenv("SMTP_PASS", "")).replace(" ", "")  # strip spaces in app password

# From address: prefer FROM_EMAIL, else fall back to SMTP_USER, else a sane default
FROM_EMAIL = os.getenv("FROM_EMAIL") or SMTP_USER or "no-reply@izzapay.shop"

def _smtp_client():
    if not SMTP_HOST:
        raise RuntimeError("SMTP_HOST not set")
    if SMTP_PORT == 465:
        server = smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=ssl.create_default_context(), timeout=20)
    else:
        server = smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20)
        server.ehlo()
        try:
            server.starttls(context=ssl.create_default_context())
            server.ehlo()  # best practice after STARTTLS
        except smtplib.SMTPException:
            # Some providers auto-negotiate TLS, continue
            pass
    if SMTP_USER:
        server.login(SMTP_USER, SMTP_PASS)
    return server

def send_email(to: str, subject: str, html: str, reply_to: str | None = None) -> bool:
    """
    Send an HTML email with a text fallback.
    Returns True/False and logs errors to stderr for Render logs.
    """
    if not to:
        print("send_email: missing recipient", file=sys.stderr)
        return False
    if not SMTP_HOST:
        print("send_email: SMTP not configured. Need SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS", file=sys.stderr)
        return False

    try:
        msg = EmailMessage()
        msg["From"] = FROM_EMAIL
        msg["To"] = to
        msg["Subject"] = subject
        if reply_to:
            msg["Reply-To"] = reply_to

        # Simple text fallback improves deliverability
        text_fallback = (html or "").replace("<br>", "\n").replace("<br/>", "\n")
        msg.set_content(text_fallback or " ")
        msg.add_alternative(html or "<p></p>", subtype="html")

        with _smtp_client() as s:
            s.send_message(msg)

        print(f"EMAIL_SENT to={to!r} subject={subject!r} reply_to={reply_to!r}", file=sys.stderr)
        return True
    except Exception as e:
        print("send_email error:", repr(e), file=sys.stderr)
        print(f"SMTP_DEBUG host={SMTP_HOST} port={SMTP_PORT} user_set={bool(SMTP_USER)} from={FROM_EMAIL!r}", file=sys.stderr)
        return False
