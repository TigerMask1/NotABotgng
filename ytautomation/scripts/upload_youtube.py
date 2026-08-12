import os
import google.auth
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
from dotenv import load_dotenv

env_path = os.path.join(os.path.dirname(__file__), '..', '.env')
load_dotenv(dotenv_path=env_path)


def get_discord_invite():
    invite = os.environ.get("DISCORD_SERVER_INVITE", "").strip()
    return invite if invite else "https://discord.gg/example"


def upload_video():
    client_id = os.environ.get("YOUTUBE_CLIENT_ID")
    client_secret = os.environ.get("YOUTUBE_CLIENT_SECRET")
    refresh_token = os.environ.get("YOUTUBE_REFRESH_TOKEN")

    if not all([client_id, client_secret, refresh_token]):
        print("Missing YOUTUBE credentials in environment variables.")
        exit(1)

    # Reconstruct credentials using refresh token
    creds = Credentials(
        token=None,
        refresh_token=refresh_token,
        client_id=client_id,
        client_secret=client_secret,
        token_uri="https://oauth2.googleapis.com/token"
    )

    youtube = build('youtube', 'v3', credentials=creds)

    video_path = os.path.join(os.path.dirname(__file__), "..", "vertical_short.mp4")
    if not os.path.exists(video_path):
        print(f"File not found: {video_path}")
        exit(1)

    print("Uploading to YouTube Shorts...")
    
    # Dynamic title extraction from the generated script
    title = "OMG IS THIS EVEN A BOT?! 🤖🔥 #shorts" # fallback
    script_path = os.path.join(os.path.dirname(__file__), "..", "assets", "example", "generated_script.txt")
    if os.path.exists(script_path):
        with open(script_path, "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("# TITLE:"):
                    title = line.replace("# TITLE:", "").strip()
                    break
    discord_invite = get_discord_invite()
    description = f"NOTABOT roasts another victim! 💀🔥 Join the chaos on Discord: {discord_invite}\n\n#discord #memes #beluga #notabot #roast #shorts"

    body = {
        'snippet': {
            'title': title,
            'description': description,
            'tags': ['discord', 'memes', 'beluga', 'funny', 'shorts', 'bot', 'roast'],
            'categoryId': '23' # Comedy
        },
        'status': {
            'privacyStatus': 'public',
            'selfDeclaredMadeForKids': False
        }
    }

    media = MediaFileUpload(video_path, chunksize=-1, resumable=True)

    request = youtube.videos().insert(
        part=",".join(body.keys()),
        body=body,
        media_body=media
    )

    response = None
    while response is None:
        status, response = request.next_chunk()
        if status:
            print(f"Uploaded {int(status.progress() * 100)}%")

    video_id = response.get('id')
    print(f"Upload Complete! Video ID: {video_id}")
    
    # Post a pinned NOTABOT-style comment
    post_comment(youtube, video_id, title)


def post_comment(youtube, video_id, title):
    """Post a funny NOTABOT-style engagement comment on the uploaded video."""
    import random
    
    # Strip #shorts and emojis from title for cleaner reference
    clean_title = title.replace("#shorts", "").replace("#Shorts", "").strip()
    
    # Read the script to give Gemini context
    script_path = os.path.join(os.path.dirname(__file__), "..", "assets", "example", "generated_script.txt")
    script_content = ""
    if os.path.exists(script_path):
        with open(script_path, "r", encoding="utf-8") as f:
            script_content = f.read()

    discord_invite = get_discord_invite()
    
    prompt = f"""
You are NOTABOT, a cold, hyper-intelligent, slightly terrifying Discord bot.
You just uploaded this video to YouTube. Write a single pinned comment for it.

Rules:
1. Speak completely in character (deadpan, factual, superior, no slang like 'bro' or 'lol').
2. Reference exactly one specific thing that happened in the script below to prove you are watching.
3. Keep it under 4 sentences.
4. Do NOT include any hashtags or emojis.
5. NEVER use the same sentence structure twice. Be wildly unique, unpredictable, and specific to THIS exact script. Do not use generic phrases like "this was a disaster" or "ducky thought he was smart."
6. Include an aggressive call-to-action demanding that they add you to their server (e.g. "you can add me to your server too. ADD ME NOW!!"). Make it sound like NOTABOT is demanding it.
7. End your comment with exactly this text (on a new line): "the server is open. for now: {discord_invite}"

SCRIPT CONTENT:
{script_content}
"""

    import google.generativeai as genai
    try:
        model = genai.GenerativeModel('gemini-3.1-flash-lite')
        response = model.generate_content(prompt)
        comment_text = response.text.strip()
    except Exception as e:
        print(f"Warning: Gemini comment generation failed, using fallback. Error: {e}")
        comment_text = f"ducky thought he could hide this. he was wrong.\nthe server is open. for now: {discord_invite}"
    
    try:
        comment_response = youtube.commentThreads().insert(
            part="snippet",
            body={
                "snippet": {
                    "videoId": video_id,
                    "topLevelComment": {
                        "snippet": {
                            "textOriginal": comment_text
                        }
                    }
                }
            }
        ).execute()
        
        comment_id = comment_response["snippet"]["topLevelComment"]["id"]
        print(f"NOTABOT comment posted! Comment ID: {comment_id}")
        
    except Exception as e:
        print(f"Warning: Could not post comment: {e}")


if __name__ == "__main__":
    upload_video()
