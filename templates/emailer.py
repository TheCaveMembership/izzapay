import os, smtplib
from email.mime.text import MIMEText

FROM = os.getenv("FROM_EMAIL", "no-reply@izzapay.shop")
SMTP_HOST = os.getenv("SMTP_HOST")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER")
SMTP_PASS = os.getenv("SMTP_PASS")

def send_email(to: str, subject: str, html: str):
    if not SMTP_HOST or not to:
        return
    msg = MIMEText(html, "html")
    msg["Subject"] = subject
    msg["From"] = FROM
    msg["To"] = to
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as s:
        s.starttls()
        if SMTP_USER:
            s.login(SMTP_USER, SMTP_PASS)
        s.sendmail(FROM, [to], msg.as_string())
