import os
from supabase import create_client, Client
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

_client: Client = None

def get_db() -> Client:
    global _client
    if _client is not None:
        return _client

    url = os.getenv("NOTABOT_SUPABASE_URL") or os.getenv("SUPABASE_URL")
    key = os.getenv("NOTABOT_SUPABASE_SERVICE_KEY") or os.getenv("NOTABOT_SUPABASE_KEY") or os.getenv("SUPABASE_KEY")

    if not url or not key:
        print("[supabase_config] ERROR: NOTABOT_SUPABASE_URL and NOTABOT_SUPABASE_SERVICE_KEY must be set.")
        return None

    _client = create_client(url, key)
    return _client
