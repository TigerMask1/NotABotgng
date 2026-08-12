import os
import firebase_admin
from firebase_admin import credentials
from firebase_admin import firestore
from dotenv import load_dotenv

load_dotenv()

_db = None

def get_db():
    global _db
    if _db is not None:
        return _db

    # Use env variables for security, fallback to local ADC if missing (like on Google Cloud)
    project_id = os.getenv("FIREBASE_PROJECT_ID")
    client_email = os.getenv("FIREBASE_CLIENT_EMAIL")
    private_key = os.getenv("FIREBASE_PRIVATE_KEY")

    if project_id and client_email and private_key:
        # Re-format private key which might have escaped newlines in .env
        private_key = private_key.replace('\\n', '\n')
        
        cred = credentials.Certificate({
            "type": "service_account",
            "project_id": project_id,
            "private_key_id": "",
            "private_key": private_key,
            "client_email": client_email,
            "client_id": "",
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
            "client_x509_cert_url": f"https://www.googleapis.com/robot/v1/metadata/x509/{client_email.replace('@', '%40')}"
        })
        
        if not firebase_admin._apps:
            firebase_admin.initialize_app(cred)
    else:
        # Fallback to application default credentials
        if not firebase_admin._apps:
            firebase_admin.initialize_app()

    _db = firestore.client()
    return _db
