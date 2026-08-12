import os
import json
import sys
import re
from supabase_config import get_db
from dotenv import load_dotenv
import google.generativeai as genai

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

API_KEY = os.environ.get("GEMINI_API_KEY")
genai.configure(api_key=API_KEY)

# Fallback models
MODEL_FALLBACKS = [
    'gemini-3-flash-preview',
    'gemini-3.1-flash-lite',
    'gemini-2.5-flash',
]

PROMPT_TEMPLATE = """You are an expert YouTube Shorts editor.
You have been given a raw transcript of a Discord conversation.
Your job is to "edit" this down into a punchy, 20-30 second viral video script.

RULES:
1. Keep the exact vibe and wording of the users. Do NOT rewrite their lines to sound "cleaner".
2. Trim the fat: remove boring messages, hellos, or dead space. Keep the conflict, the joke, and the punchline.
3. Add pacing markers at the end of each line using `$duration#!soundeffect`. 
   Valid sound effects: click, confusion, error, explosion, hamburger, hehascome, join, knock, leave, message, modeugene, modpablo, pop, scary, softmessage, typing, vineboom, zap.
   Duration: usually 1.5 to 3.0 seconds.
4. DO NOT add any extra markdown formatting (no ```txt blocks).
5. At the very top, you MUST include a JSON metadata block mapping the authors to their avatars, exactly like this format:
{{"characters": {{"NotABot": {{"avatar_url": "url", "role_color": "#5A67D8"}}}}}}
6. Followed by a `# TITLE: <viral title> #shorts` line.
7. Then the transcript in `Author:\nMessage$^2.5#!message` format.

RAW TRANSCRIPT DATA:
{metadata_json}

MESSAGES:
{messages_text}
"""

def build_metadata(messages):
    characters = {}
    for m in messages:
        author = str(m.get('author') or 'unknown').strip()
        avatar_url = m.get('avatarUrl') or ''
        if author not in characters:
            characters[author] = {
                'avatar_url': avatar_url,
                'role_color': '#5A67D8'
            }
    return {"characters": characters}

def process():
    db = get_db()
    if not db:
        print("Failed to connect to Supabase.")
        sys.exit(1)

    # Find the oldest unprocessed queue item
    response = db.from_('youtube_queue') \
        .select('*') \
        .eq('status', 'pending') \
        .order('queued_at', desc=False) \
        .limit(1) \
        .execute()

    rows = response.data or []
    if not rows:
        print("QUEUE_EMPTY")
        sys.exit(0)

    row = rows[0]
    row_id = row['id']
    messages = row.get('messages', [])

    if not messages:
        db.from_('youtube_queue').update({'status': 'processed'}).eq('id', row_id).execute()
        print("QUEUE_EMPTY")
        sys.exit(0)

    metadata = build_metadata(messages)

    msg_lines = []
    for m in messages:
        author = str(m.get('author') or 'unknown').strip()
        content = str(m.get('content') or '').strip()
        msg_lines.append(f"[{author}]: {content}")

    clip_mode = row.get('clip_mode', 'normal')

    prompt = PROMPT_TEMPLATE.format(
        metadata_json=json.dumps(metadata),
        messages_text='\n'.join(msg_lines)
    )

    if clip_mode == 'unhinged':
        prompt += "\n8. UNHINGED MODE: Rewrite NotABot's lines to be completely chaotic. Use all caps, screaming, poor grammar, unhinged takes, and lots of emojis (but do not spam). Make NotABot sound completely deranged but hilarious."

    script_content = None
    for model_name in MODEL_FALLBACKS:
        try:
            model = genai.GenerativeModel(model_name=model_name)
            response = model.generate_content(prompt)
            script_content = response.text
            break
        except Exception as e:
            print(f"Failed with {model_name}: {e}")

    if not script_content:
        print("Failed to generate script with all models.")
        sys.exit(1)

    # Strip markdown code blocks if the model accidentally included them
    script_content = re.sub(r'```(?:txt)?\n(.*?)\n```', r'\1', script_content, flags=re.DOTALL)

    # Write to file
    out_dir = os.path.join(os.path.dirname(__file__), '..', 'assets', 'example')
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, 'generated_script.txt')

    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(script_content)

    # Mark as processed in Supabase
    db.from_('youtube_queue').update({'status': 'processed'}).eq('id', row_id).execute()
    print("SUCCESS")

if __name__ == "__main__":
    process()
