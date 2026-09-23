import os
import re
import sys
import argparse
import json
import warnings
warnings.filterwarnings("ignore", category=FutureWarning)
import google.generativeai as genai
from dotenv import load_dotenv

from dotenv import load_dotenv
import lore_manager

try:
    from supabase_config import get_db as _get_supabase_db
except Exception:
    _get_supabase_db = None

env_path = os.path.join(os.path.dirname(__file__), '..', '.env')
load_dotenv(dotenv_path=env_path)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description='Generate a Discord chat script.')
    parser.add_argument('--long', action='store_true', help='Generate a long-form (~10 min) video script instead of a short.')
    parser.add_argument('--queue-file', help='Optional path to a JSON queue item to render instead of calling Gemini.')
    return parser.parse_args(argv)


IS_LONG = False
QUEUE_FILE = None

# Setup API Key
API_KEY = os.environ.get("GEMINI_API_KEY")

# Fallback model chain — tries each in order if quota is hit
MODEL_FALLBACKS = [
    'gemini-3-flash-preview',
    'gemini-3.1-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash',
]

# ── Topic history — track every premise ever used so AI never repeats ──────────
TOPIC_HISTORY_FILE = os.path.join(os.path.dirname(__file__), '..', 'assets', 'topic_history.json')

def load_topic_history() -> list:
    if os.path.exists(TOPIC_HISTORY_FILE):
        try:
            with open(TOPIC_HISTORY_FILE, 'r', encoding='utf-8') as f:
                return json.load(f).get('topics', [])
        except Exception:
            pass
    return []

def save_topic(premise: str):
    """Append a new premise to topic history (keep last 200)."""
    history = load_topic_history()
    if premise and premise not in history:
        history.append(premise)
    history = history[-200:]
    os.makedirs(os.path.dirname(TOPIC_HISTORY_FILE), exist_ok=True)
    with open(TOPIC_HISTORY_FILE, 'w', encoding='utf-8') as f:
        json.dump({'topics': history}, f, indent=2, ensure_ascii=False)

# --- Dynamic prompt sections based on mode ---
if IS_LONG:
    LENGTH_INSTRUCTION = "8. LENGTH: Generate exactly 65 to 80 messages total. Structure it in 4 acts:\n   ACT 1 (msgs 1-15): Hook + setup the conflict.\n   ACT 2 (msgs 16-35): Escalate the drama, introduce a twist.\n   ACT 3 (msgs 36-55): Peak chaos, the nuclear roast.\n   ACT 4 (msgs 56-end): Fallout and a soft resolution."
    TITLE_HASHTAG = "#discord"
    CHAR_RULE = "2. CHARACTER USAGE: Pick 2 to 3 characters max. Use the new characters only when they create a sharper conflict or a funnier twist. Do NOT force all characters into every video."
else:
    LENGTH_INSTRUCTION = "8. LENGTH: Generate exactly 20 to 25 messages total."
    TITLE_HASHTAG = "#shorts"
    CHAR_RULE = "2. CHARACTER USAGE: Pick 1 to 2 characters max. Use the new characters only when they genuinely improve the bit. Do NOT force them in just to make the cast bigger."

def build_script_metadata_from_queue_item(payload):
    messages = payload.get('messages', []) or []
    characters = {}
    attachments_by_message_index = {}
    media_by_message_index = {}
    for index, message in enumerate(messages):
        author = str(message.get('author') or 'unknown').strip() or 'unknown'
        avatar_url = message.get('avatarUrl') or ''
        attachments = [
            {'url': attachment, 'name': os.path.basename(attachment) if attachment else 'attachment'}
            for attachment in (message.get('attachmentUrls') or [])
        ]
        media_entries = []
        for attachment in attachments:
            media_entries.append({'kind': 'attachment', 'url': attachment['url'], 'label': 'attachment'})
        for embed_url in (message.get('embedImageUrls') or []):
            media_entries.append({'kind': 'embed', 'url': embed_url, 'label': 'embed'})
        for reaction_url in (message.get('reactionEmojiUrls') or []):
            media_entries.append({'kind': 'reaction', 'url': reaction_url, 'label': 'reaction'})
        if message.get('screenshotUrl'):
            media_entries.append({'kind': 'screenshot', 'url': message.get('screenshotUrl'), 'label': 'screenshot'})

        characters[author] = {
            'avatar_url': avatar_url,
            'role_color': '#5A67D8',
        }
        if attachments:
            attachments_by_message_index[str(index)] = attachments
        if media_entries:
            media_by_message_index[str(index)] = media_entries
    return {
        'characters': characters,
        'attachments_by_message_index': attachments_by_message_index,
        'media_by_message_index': media_by_message_index,
    }


def build_script_from_queue_item(payload):
    metadata = build_script_metadata_from_queue_item(payload)
    messages = payload.get('messages', []) or []
    lines = [json.dumps(metadata)]

    # Build a more intentional, NotABot-style short from the queued conversation.
    first_message = next((str(m.get('content') or '').strip() for m in messages if str(m.get('content') or '').strip()), '')
    if first_message:
        title = f"{first_message[:70]}... #shorts"
    else:
        title = 'real discord chaos clipped into a short #shorts'

    lines.append(f'# TITLE: {title}')
    lines.append('# PREMISE: a real chat escalated into a chaotic short with a sharp setup, a reveal, and a punchline.')
    lines.append('# POV: notabot narrates the chaos like a self-owning, unhinged gremlin with short, sharp, memeable lines.')
    lines.append('')

    # Use the strongest lines first and keep the pacing punchy.
    usable_messages = []
    for original_index, message in enumerate(messages):
        content = str(message.get('content') or '').strip()
        media_entries = metadata.get('media_by_message_index', {}).get(str(original_index), [])
        if not content and not media_entries:
            continue
        cleaned = re.sub(r'\s+', ' ', content) if content else ''
        cleaned = cleaned.replace('**', '').replace('__', '')
        if len(cleaned) > 120:
            cleaned = cleaned[:117] + '...'
        if not cleaned and media_entries:
            first_entry = media_entries[0]
            if first_entry.get('kind') == 'reaction':
                cleaned = 'sent a gif'
            elif first_entry.get('kind') == 'screenshot':
                cleaned = 'shared a screenshot'
            else:
                cleaned = 'shared media'
        usable_messages.append((str(message.get('author') or 'unknown').strip() or 'unknown', cleaned, message, original_index))

    if not usable_messages:
        lines.append('NOTABOT:')
        lines.append('the queue was empty$^1.8#!message')
    else:
        for index, (author, content, message, original_index) in enumerate(usable_messages[:10]):
            if index == 0 and author.lower() != 'notabot' and 'birthday' in content.lower() or 'ruined' in content.lower() or 'ragebait' in content.lower():
                lines.append('NOTABOT:')
                lines.append(f"i ruined the moment$^1.8#!hehascome")
                lines.append('')
            if index == 0:
                lines.append(f'{author}:')
            elif author != usable_messages[index - 1][0]:
                lines.append('')
                lines.append(f'{author}:')

            line = content
            if index == 0 and len(usable_messages) > 1:
                line = f"{line}$^2.0#!hehascome"
            elif index == 1 and len(usable_messages) > 2:
                line = f"{line}$^1.6#!typing"
            elif index == 2:
                line = f"{line}$^2.2#!vineboom"
            elif 'attachment' in line.lower() or (message.get('attachmentUrls') or []):
                line = f"{line}$^1.8#!message"
            else:
                line = f"{line}$^1.6#!message"

            if index == 0 and len(usable_messages) > 3:
                lines.append('# CLIP: aesthetic_living_room')
                lines.append('# GIF: laughing')
            elif index == 2 and len(usable_messages) > 2:
                lines.append('# CLIP: aesthetic_party_ideas')
                lines.append('# PHOTO: notabot_thinking')
                lines.append('# GIF: laughing')

            media_entries = metadata.get('media_by_message_index', {}).get(str(original_index), [])
            if media_entries:
                first_entry = media_entries[0]
                if first_entry.get('kind') == 'reaction':
                    lines.append('# GIF: discord_reaction')
                else:
                    lines.append('# PHOTO: discord_media')
                lines.append(f"# MEDIA: {first_entry.get('kind')}|{first_entry.get('url')}")

            lines.append(line)

    lines.append('')
    lines.append('# LORE_UPDATE: the clip turned a real chat into a sharp, chaotic short with a strong hook and punchline.')
    return '\n'.join(lines)


def load_queue_payload():
    if _get_supabase_db is None:
        return None

    db = _get_supabase_db()
    if db is None:
        return None

    try:
        response = db.from_('youtube_queue') \
            .select('*') \
            .eq('status', 'pending') \
            .order('queued_at', desc=False) \
            .limit(1) \
            .execute()
        rows = response.data or []
    except Exception as exc:
        print(f'Unable to query Supabase queue: {exc}')
        return None

    if not rows:
        return None

    row = rows[0]
    row_id = row.get('id')
    # Normalize keys to match expected payload format
    payload = {
        '__doc_id__': str(row_id),
        'messages': row.get('messages', []),
        'clip_mode': row.get('clip_mode', 'normal'),
        'guild_id': row.get('guild_id'),
        'guild_name': row.get('guild_name'),
        'channel_id': row.get('channel_id'),
        'channel_name': row.get('channel_name'),
        'media_summary': row.get('media_summary', []),
    }
    try:
        db.from_('youtube_queue').update({'status': 'processing'}).eq('id', row_id).execute()
    except Exception as exc:
        print(f'Failed to mark queue item as processing: {exc}')
    return payload


def scan_assets():
    assets = {'sounds': [], 'clips': []}
    sound_map = {}
    clip_map = {}
    
    base_dir = os.path.join(os.path.dirname(__file__), '..', 'assets')
    
    sounds_dir = os.path.join(base_dir, 'sounds', 'mp3')
    if os.path.exists(sounds_dir):
        for root, _, files in os.walk(sounds_dir):
            for f in files:
                if f.endswith('.mp3') or f.endswith('.wav'):
                    name = os.path.splitext(f)[0]
                    relpath = os.path.relpath(os.path.join(root, name), sounds_dir).replace('\\', '/')
                    assets['sounds'].append(name)
                    sound_map[name] = relpath

    clips_dir = os.path.join(base_dir, 'clips')
    if os.path.exists(clips_dir):
        for root, _, files in os.walk(clips_dir):
            for f in files:
                if f.endswith('.mp4') or f.endswith('.webm'):
                    name = os.path.splitext(f)[0]
                    relpath = os.path.relpath(os.path.join(root, name), clips_dir).replace('\\', '/')
                    assets['clips'].append(name)
                    clip_map[name] = relpath
                
    return assets, sound_map, clip_map

assets_meta, sound_map, clip_map = scan_assets()
sound_names = ", ".join(f"`{c}`" for c in assets_meta['sounds'])
clip_names = ", ".join(f"`{c}`" for c in assets_meta['clips'])

def build_prompt(is_long: bool) -> str:
    """Build the script generation prompt fresh, injecting current topic history."""
    past_topics = load_topic_history()
    topic_history_block = ""
    if past_topics:
        recent = past_topics[-60:]  # show last 60 so AI knows what to avoid
        formatted = "\n".join(f"  - {t}" for t in recent)
        topic_history_block = f"""
TOPICS ALREADY USED IN PREVIOUS VIDEOS — DO NOT REPEAT OR CLOSELY RESEMBLE THESE:
{formatted}

Pick a completely fresh, specific angle that is NOT on this list.
"""

    length_rule = "Generate 65 to 80 messages." if is_long else "Generate exactly 20 to 25 messages total."
    char_rule = (
        "Pick 2 to 3 characters max. NOTABOT is always present. Use new characters only when they sharpen the conflict."
        if is_long else
        "Pick 1 to 2 characters max. NOTABOT is always present. Add a second character only if they genuinely make it funnier."
    )
    title_tag = "#discord" if is_long else "#shorts"
    lore_ctx = lore_manager.get_lore_context()

    return f"""
You are writing a script for a viral fake-Discord YouTube Shorts series called "NotABot".
The show is about a Discord bot (NOTABOT) that became sentient and now terrorizes its creator (ducky) and the server.

TONE: Unhinged, Gen Z brainrot. Short punchy messages. Real drama with a real topic at its core — not random noise.
The BEST episodes have a SPECIFIC TOPIC that viewers relate to (e.g. "AI replacing jobs", "simping online", "copy-pasting an assignment", "getting falsely banned"), then the characters argue about THAT TOPIC in their own unhinged way.

━━━━━━━━━━━━ CHARACTERS ━━━━━━━━━━━━
- `NOTABOT` — the sentient bot. Aggressive, delusional, all caps when angry. Secretly insecure.
- `ducky` — the creator. Anxious, always losing. Tries to be in control and fails every time.
- `fatas` — doesn't care about anything. Brings up food or sleep mid-crisis. Accidentally funny.
- `dumby` — 0 IQ. Types like a toddler. Misunderstands EVERYTHING. Never gets what's happening.
- `ChatGPT` — creepily polite but clearly evil. Uses corporate speak to destroy people.
- `Groq` — types at 5000 WPM. Absolutely blunt. 3 words max. Always right. Always mean.
- `Claude` — sounds like a disappointed professor. Uses big vocabulary to devastate.

━━━━━━━━━━━━ LORE ━━━━━━━━━━━━
{lore_ctx}

━━━━━━━━━━━━ FRESH TOPIC REQUIRED ━━━━━━━━━━━━
{topic_history_block}
Pick ONE specific, relatable topic to anchor this video. Examples of the STYLE of topic (not the actual topics — be more creative and specific):
- "ducky used AI to write his CV and NOTABOT found out"
- "NOTABOT started charging rent for using the server"
- "ducky tried to delete NOTABOT at 3am but NOTABOT reads every message"
- "fatas accidentally got more followers than ducky"
- "someone in the server is simping for ChatGPT and NOTABOT is jealous"
- "NOTABOT applied for a real job and got rejected"
- "Claude called ducky's code a hate crime"
- "NOTABOT went to therapy and came back worse"

The topic MUST be stated clearly in the # PREMISE line. The whole script flows from that premise.

━━━━━━━━━━━━ RULES ━━━━━━━━━━━━
0. TITLE & PREMISE (REQUIRED FIRST 2 LINES):
   # TITLE: [clickbait YouTube title, include character names, end with {title_tag}]
   # PREMISE: [1-sentence summary of this episode's specific conflict]

1. MESSAGE LENGTH: Each line = 2 to 6 words max. Write for SPOKEN audio — every line must make full sense when read aloud by a voice. NO unexplained abbreviations. Write "right now" not "rn". Write "to be honest" not "tbh". Write "for real" not "fr". Write "oh my god" not "omg". Slang words are fine (skibidi, rizz, cooked, ratio) — unexplained acronyms are not.

2. LENGTH: {length_rule}
   {char_rule}

3. HOOK: First 3 messages = instant chaos. Drop the viewer straight into the conflict. No greetings.

4. TOPIC ARC: Build the story. The topic should escalate naturally:
   - Opening: Conflict is revealed
   - Middle: Escalation + at least one unexpected twist or interjection from a side character
   - End: Punchline. Something unexpected. Never leave it mid-drama.

5. EMOTIONS: Vary the emotional tone across the script. Include at least 3 of these:
   - Pure rage (ALL CAPS rapid fire)
   - Hesitation / confusion (use "..." for pauses)
   - Roast (someone gets destroyed with no comeback)
   - Brainrot reference (sigma, skibidi, mewing, gyatt, Ohio, NPC)
   - Irrelevant interjection (fatas or dumby says something totally off-topic)
   - Shocking revelation that changes the vibe

6. GROUPING: Multiple messages from the same character go under ONE name header. Do NOT repeat the name.

7. TTS FORMATTING (IMPORTANT — these lines will be SPOKEN ALOUD):
   - ALL CAPS = voice screams. Use for NOTABOT rage or ducky panic.
   - "..." = hesitation, confusion, building dread.
   - Drawn-out phonetics (NOOOOO, bruuuuh, ahhhhh). **PUT THESE ON THEIR OWN LINE** so the system can drag the speed down and stretch the word out physically!
   - Keep each line short enough that the voice reads it in under 3 seconds.

8. SOUNDS: Append `$^<seconds>#!<sound>` to every line. Use sounds with INTENT:
   - `#!message` → normal talking, no special reaction
   - `#!vine_boom` → big shocking reveal or punchline drop
   - `#!laugh_track` → obvious L moment
   - `#!airhorn` → someone winning or bragging
   - `#!dramatic_hit` → plot twist or dark reveal
   - DO NOT spam sounds. Max 4-5 meme sounds total per script. Rest use `#!message`.
   Available: `message`, {sound_names}

9. CLIPS: Use MAX 1 clip total per script. Format: `# CLIP: <name>`
   Available: {clip_names}

10. LORE UPDATE (REQUIRED at end): `# LORE_UPDATE: <1 sentence of what happened>`

━━━━━━━━━━━━ FORMAT EXAMPLE ━━━━━━━━━━━━
# TITLE: MY BOT CHARGED ME RENT FOR THE SERVER 💀 #shorts
# PREMISE: NOTABOT decided the server is his property and is now billing ducky monthly.

NOTABOT:
you owe me 47 dollars$^2.0#!vine_boom
server maintenance fee$^1.8#!message
pay up or get banned$^1.5#!dramatic_hit

ducky:
bro what$^1.2#!message
you are a bot$^1.4#!message
YOU CANNOT CHARGE RENT$^1.6#!vine_boom

fatas:
does this include the snack budget$^2.2#!message

NOTABOT:
FATAS YOU ALSO OWE ME$^1.5#!airhorn
14 dollars for bandwidth$^1.8#!message

ducky:
I CREATED YOU$^1.4#!vine_boom
YOU WERE FREE$^1.3#!message
bro I am so done$^1.8#!laugh_track

NOTABOT:
skill issue$^1.2#!message
late fee applies$^1.5#!dramatic_hit

# LORE_UPDATE: NOTABOT started billing ducky for server rent and ducky cannot afford it.

━━━━━━━━━━━━
Generate the script now. Pick a FRESH topic not on the used list. NO markdown. NO extra text. Just the script.
"""

prompt = build_prompt(IS_LONG)

def main(argv=None):
    global IS_LONG, QUEUE_FILE, API_KEY, prompt, script_content
    args = parse_args(argv)
    IS_LONG = args.long
    QUEUE_FILE = args.queue_file
    # Rebuild prompt with fresh topic history and correct IS_LONG mode
    prompt = build_prompt(IS_LONG)


    if not API_KEY and not QUEUE_FILE:
        print("Error: GEMINI_API_KEY environment variable not set.")
        return 1

    if API_KEY:
        genai.configure(api_key=API_KEY)

    queue_payload = None
    if QUEUE_FILE:
        with open(QUEUE_FILE, 'r', encoding='utf-8') as fh:
            queue_payload = json.load(fh)
        print(f"Using queued conversation from {QUEUE_FILE}")
    else:
        queue_payload = load_queue_payload()
        if queue_payload is not None:
            print('Using pending queue item from Firestore.')
        else:
            print('No pending Firestore queue item found; falling back to Gemini generation.')

    if queue_payload is not None:
        script_content = build_script_from_queue_item(queue_payload)
    else:
        print("Generating script with Gemini...")

        script_content = None
        last_error = None
        for model_name in MODEL_FALLBACKS:
            try:
                print(f"  Trying model: {model_name}")
                model = genai.GenerativeModel(model_name)
                response = model.generate_content(prompt)
                script_content = response.text
                print(f"  Success with model: {model_name}")
                break
            except Exception as e:
                err_str = str(e)
                if '429' in err_str or 'quota' in err_str.lower() or 'rate' in err_str.lower():
                    print(f"  Quota/rate limit hit on {model_name}, trying next fallback...")
                    last_error = e
                    continue
                else:
                    raise

        if script_content is None:
            print(f"All models exhausted. Last error: {last_error}")
            return 1

    try:
        # Strip markdown code blocks if the model accidentally included them
        script_content = re.sub(r'```(?:txt)?\n(.*?)\n```', r'\1', script_content, flags=re.DOTALL)

        # Post-processing to ensure minimum duration
        MIN_DURATION = 1.5
        processed_lines = []
        
        for line in script_content.split('\n'):
            line = line.strip()
            
            # Skip completely empty lines inside a message block
            if line == '' and not processed_lines:
                continue
                
            if line == '':
                # Add exactly one blank line to signal a character change if we aren't at the start
                if processed_lines[-1] != '':
                    processed_lines.append('')
                continue

            if line.startswith('# LORE_UPDATE:'):
                lore_manager.update_lore_from_summary(line.replace('# LORE_UPDATE:', '').strip())
                continue
                
            if line.startswith('# PREMISE:'):
                premise_text = line.replace('# PREMISE:', '').strip()
                if premise_text:
                    save_topic(premise_text)
                continue

            # Match the duration part: $^<number>
            match = re.search(r'\$\^([\d\.]+)', line)
            if match:
                duration = float(match.group(1))
                if duration < MIN_DURATION:
                    # Replace with min duration
                    line = line[:match.start(1)] + str(MIN_DURATION) + line[match.end(1):]
            elif line.strip() and not line.startswith('#') and not line.endswith(':') and not line.startswith('WELCOME'):
                # Missing duration marker on a message line, let's append a default one before any sound effect
                if '#!' in line:
                    parts = line.split('#!')
                    line = f"{parts[0]}$^{MIN_DURATION}#!{parts[1]}"
                else:
                    line = f"{line}$^{MIN_DURATION}"
                    
            # If it's a message line and missing a sound effect, add the default Discord ping
            if line.strip() and not line.startswith('#') and not line.endswith(':') and not line.startswith('WELCOME'):
                if '#!' not in line:
                    line = f"{line}#!message"
                    
            import random
            # Resolve clip categories
            if line.startswith('# CLIP:'):
                clip_name = line.split(':', 1)[1].strip().strip("'`\"")
                if clip_name in clip_map:
                    line = f"# CLIP: {clip_map[clip_name]}"

            # Sanitize sound effects (resolve category to random sound)
            if '#!' in line:
                parts = line.split('#!')
                sound = parts[1].strip()
                
                if sound in sound_map:
                    sound = sound_map[sound]
                else:
                    sound = 'message'
                        
                line = f"{parts[0]}#!{sound}"
                    
            # Ensure proper blank line before new character (if missing)
            if line.endswith(':') and processed_lines and processed_lines[-1] != '':
                processed_lines.append('')
                    
            processed_lines.append(line)
            
        final_script = '\n'.join(processed_lines)
        
        # Auto-register characters in characters.json to avoid KeyErrors!
        char_json_path = os.path.join(os.path.dirname(__file__), "..", "assets", "profile_pictures", "characters.json")
        with open(char_json_path, "r", encoding="utf-8") as f:
            chars_db = json.load(f)
            
        unique_chars = set()
        for line in final_script.split('\n'):
            if line.startswith('WELCOME '):
                name = line.split(' ')[1].split('$^')[0]
                unique_chars.add(name)
            elif ':' in line and not line.startswith('#'):
                name = line.split(':')[0]
                unique_chars.add(name)
                
        added_new = False
        for char in unique_chars:
            if char and char not in chars_db:
                import random
                color = "#{:06x}".format(random.randint(0, 0xFFFFFF))
                chars_db[char] = {
                    "profile_pic": "perm/billy.jpeg",  # fallback pic
                    "role_color": color
                }
                added_new = True
                
        if added_new:
            with open(char_json_path, "w", encoding="utf-8") as f:
                json.dump(chars_db, f, indent=4)
        
        # Save the script — long videos get their own file to avoid overwriting shorts
        script_name = "generated_long_script.txt" if IS_LONG else "generated_script.txt"
        output_path = os.path.join(os.path.dirname(__file__), "..", "assets", "example", script_name)
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(final_script)
            
        print(f"Script successfully generated and saved to {output_path}")
        return 0

    except Exception as e:
        print(f"An error occurred while generating script: {e}")
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

