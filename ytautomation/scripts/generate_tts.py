import os
import sys
import argparse
import asyncio
import edge_tts
from moviepy.editor import AudioFileClip
import re

# ── BASE VOICE MAP ────────────────────────────────────────────────────────────
# These are the CHARACTER DEFAULTS. Per-line emotion adjustments are applied on top.
VOICE_MAP = {
    # NOTABOT: deep, authoritative, moderately fast — varies wildly with emotion
    'notabot':  {'voice': 'en-US-GuyNeural',       'rate': '+15%', 'pitch': '-25Hz'},
    # ducky: naturally a bit higher, panicky — goes squeaky when scared
    'ducky':    {'voice': 'en-GB-RyanNeural',       'rate': '+20%', 'pitch': '+25Hz'},
    # dumby: slow, deep, confused — like a toddler reading for the first time
    'dumby':    {'voice': 'en-US-SteffanNeural',    'rate': '-25%', 'pitch': '-40Hz'},
    # fatas: dead slow, totally unbothered — sounds half asleep
    'fatas':    {'voice': 'en-AU-WilliamNeural',    'rate': '-18%', 'pitch': '-8Hz'},
    # chatgpt: upbeat robot — passive aggressive cheerfulness
    'chatgpt':  {'voice': 'en-US-AvaNeural',        'rate': '+18%', 'pitch': '+18Hz'},
    # groq: lightning fast, clipped, aggressive — sounds like a speedrunner
    'groq':     {'voice': 'en-US-AndrewNeural',     'rate': '+45%', 'pitch': '+5Hz'},
    # claude: measured, slightly slow, smug — disappointed professor vibes
    'claude':   {'voice': 'en-US-BrianNeural',      'rate': '-8%',  'pitch': '+12Hz'},
}
DEFAULT_VOICE = {'voice': 'en-US-ChristopherNeural', 'rate': '+10%', 'pitch': '+0Hz'}


# ── ABBREVIATION → FULL FORM ───────────────────────────────────────────────────
# The SCREEN shows the shortform; the VOICE says the full form.
# TTS reads these letter-by-letter otherwise, which sounds terrible.
ABBREVIATIONS = {
    r'\brn\b':     'right now',
    r'\bfr\b':     'for real',
    r'\btbh\b':    'to be honest',
    r'\bngl\b':    'not gonna lie',
    r'\bidk\b':    "I don't know",
    r'\bidc\b':    "I don't care",
    r'\bstfu\b':   'shut up',
    r'\bomg\b':    'oh my god',
    r'\blol\b':    'laughing out loud',
    r'\blmao\b':   'laughing my ass off',
    r'\bpls\b':    'please',
    r'\bbrb\b':    'be right back',
    r'\bbtw\b':    'by the way',
    r'\bimo\b':    'in my opinion',
    r'\bwdym\b':   'what do you mean',
    r'\bwth\b':    'what the heck',
    r'\bwtf\b':    'what the heck',  # keep it clean-ish for TTS
    r'\bnpc\b':    'en-pee-see',
    r'\bbro\b':    'bro',            # keep, it's a real word now
    r'\b(?<!\w)u\b':  'you',        # standalone "u" → "you"
    r'\bur\b':     'your',
    r'\bw\b':      'win',
    r'\bl\b':      'loss',
    r'\bgg\b':     'good game',
    r'\baura\b':   'aura',          # keep, it's a real word in this context
}

def expand_abbreviations(text: str) -> str:
    """Expand shortforms so TTS says them correctly. Case-insensitive."""
    result = text
    for pattern, replacement in ABBREVIATIONS.items():
        result = re.sub(pattern, replacement, result, flags=re.IGNORECASE)
    return result


# ── EMOTION-AWARE VOICE ADJUSTMENT ────────────────────────────────────────────
# Reads cues from the RAW TEXT (not expanded) and bumps pitch/rate to match emotion.
# This gives each LINE its own energy on top of the character's base voice.

def get_emotion_adjustment(raw_text: str) -> tuple[int, int]:
    """
    Returns (pitch_delta_hz, rate_delta_percent) to add on top of base voice.
    Detects emotion signals directly from the text before abbreviation expansion.
    """
    upper_count = sum(1 for c in raw_text if c.isupper() and c.isalpha())
    total_alpha = sum(1 for c in raw_text if c.isalpha())
    caps_ratio = upper_count / total_alpha if total_alpha > 0 else 0

    pitch_delta = 0
    rate_delta = 0

    # ── SCREAMING: mostly caps, 5+ chars ────────────────────────────────
    # Goes for both NOTABOT rage AND ducky panic
    if caps_ratio >= 0.75 and total_alpha >= 5:
        pitch_delta += 12     # noticeably higher/more intense
        rate_delta += 20      # faster, more urgent

    # ── SUPER INTENSE SCREAMING: all caps, long line ─────────────────────
    if caps_ratio >= 0.9 and total_alpha >= 10:
        pitch_delta += 8      # stack on top of the above
        rate_delta += 10

    # ── HESITATION/DREAD: ellipsis ───────────────────────────────────────
    if '...' in raw_text:
        rate_delta -= 18      # slow down significantly
        # don't touch pitch — the slowdown creates the eerie feeling

    # ── DRAWN-OUT VOWELS (Stretching the word): NOOOOO, bruuuuh, ahhhhh ────────
    if re.search(r'(.)\1{3,}', raw_text):
        pitch_delta += 10
        
        # If the entire line is basically just the dragged out word (less than 3 words)
        # We can drop the speed massively to physically "drag" the audio out
        if word_count <= 2:
            rate_delta -= 40  # Massive slowdown to drag the word
        else:
            rate_delta -= 15  # Moderate slowdown if it's part of a larger sentence

    # ── QUESTIONING/DISBELIEF: ??? or wait what ───────────────────────────
    if '???' in raw_text or raw_text.strip().endswith('???'):
        pitch_delta += 8

    # ── VERY SHORT PUNCHLINE (1-2 words, probably a roast) ───────────────
    word_count = len(raw_text.strip().split())
    if word_count <= 2 and total_alpha >= 2:
        rate_delta += 5       # punchy and snappy

    # ── TOTALLY CALM / LOWERCASE / SHORT ────────────────────────────────
    if caps_ratio < 0.1 and total_alpha >= 3:
        rate_delta -= 5       # slightly more chill
        pitch_delta -= 3

    return pitch_delta, rate_delta


def apply_adjustment(base_config: dict, pitch_delta: int, rate_delta: int) -> dict:
    """
    Combine base voice config with per-line emotion deltas.
    Returns a new dict — doesn't mutate the original.
    """
    def parse_hz(s):
        return int(re.search(r'[-+]?\d+', s).group())

    def parse_rate(s):
        return int(re.search(r'[-+]?\d+', s).group())

    base_pitch = parse_hz(base_config.get('pitch', '+0Hz'))
    base_rate = parse_rate(base_config.get('rate', '+0%'))

    new_pitch = max(-50, min(50, base_pitch + pitch_delta))
    new_rate = max(-50, min(60, base_rate + rate_delta))

    pitch_str = f"+{new_pitch}Hz" if new_pitch >= 0 else f"{new_pitch}Hz"
    rate_str  = f"+{new_rate}%" if new_rate >= 0 else f"{new_rate}%"

    return {
        'voice': base_config['voice'],
        'rate':  rate_str,
        'pitch': pitch_str,
    }


async def generate_audio(text, output_path, voice_config):
    communicate = edge_tts.Communicate(
        text,
        voice_config['voice'],
        rate=voice_config.get('rate', '+0%'),
        pitch=voice_config.get('pitch', '+0Hz'),
    )
    await communicate.save(output_path)


def clean_for_tts(text: str) -> str:
    """Strip script formatting tags and non-ASCII. Then expand abbreviations."""
    # Strip emoji / non-ASCII
    text = re.sub(r'[^\x00-\x7F]+', '', text)
    # Strip markdown
    text = re.sub(r'[*_`~]', '', text)
    # Collapse spaces
    text = re.sub(r'\s+', ' ', text).strip()
    # Expand abbreviations so TTS speaks full words
    text = expand_abbreviations(text)
    return text


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--script_path', required=True)
    parser.add_argument('--tts_dir', required=True)
    args = parser.parse_args()

    script_path = args.script_path
    tts_dir = args.tts_dir
    os.makedirs(tts_dir, exist_ok=True)

    if not os.path.exists(script_path):
        print(f"Error: {script_path} not found")
        sys.exit(1)

    with open(script_path, 'r', encoding='utf-8') as f:
        lines = f.read().splitlines()

    current_char = None
    processed_lines = []
    tts_counter = 0

    async def process_lines():
        nonlocal current_char, tts_counter

        for line in lines:
            stripped = line.strip()

            # Blank lines / comment lines — pass through unchanged
            if not stripped or stripped.startswith('#'):
                processed_lines.append(line)
                continue

            # Character header line like "NOTABOT:" or "ducky:"
            if stripped.endswith(':') and '$^' not in stripped:
                current_char = stripped[:-1].strip().lower()
                processed_lines.append(line)
                continue

            # Dialogue line — parse out text / duration / sound / existing tts tag
            text_part = stripped
            duration_part = ''
            sound_part = ''
            existing_tts = ''

            if '$^' in text_part:
                left, right = text_part.split('$^', 1)
                text_part = left
                if '#@' in right:
                    right, existing_tts = right.split('#@', 1)
                    existing_tts = existing_tts.strip()
                if '#!' in right:
                    d, s = right.split('#!', 1)
                    duration_part = d.strip()
                    sound_part = s.strip()
                else:
                    duration_part = right.strip()
            elif '#!' in text_part:
                left, s = text_part.split('#!', 1)
                text_part = left
                sound_part = s.strip()

            # Already has TTS tag (re-run) — keep as-is
            if existing_tts:
                processed_lines.append(line)
                continue

            raw_text = text_part.strip()
            tts_text = clean_for_tts(raw_text)

            if len(tts_text) > 1 and current_char is not None:
                tts_counter += 1
                audio_filename = f"tts_{tts_counter}.mp3"
                audio_path = os.path.join(tts_dir, audio_filename)

                # Base voice for this character
                base_config = VOICE_MAP.get(current_char, DEFAULT_VOICE)

                # Emotion adjustment based on raw line text
                pitch_delta, rate_delta = get_emotion_adjustment(raw_text)
                final_config = apply_adjustment(base_config, pitch_delta, rate_delta)

                emotion_tag = ""
                if pitch_delta > 10 or rate_delta > 15:
                    emotion_tag = " [SCREAM]"
                elif pitch_delta < 0 or rate_delta < -10:
                    emotion_tag = " [hesitant]"

                print(f"  [TTS] {current_char}{emotion_tag} ({final_config['voice']} {final_config['rate']} {final_config['pitch']}): {tts_text[:60]}")

                try:
                    await generate_audio(tts_text, audio_path, final_config)

                    clip = AudioFileClip(audio_path)
                    # Frame duration = exact TTS length + 0.15s tail (no more desync!)
                    tts_duration = round(clip.duration + 0.15, 2)
                    clip.close()

                    # Always use TTS duration — ignore the AI-guessed duration
                    final_duration = tts_duration

                    # Rebuild line: text$^duration#!sound#@tts_file
                    new_line = f"{raw_text}$^{final_duration}"
                    if sound_part:
                        new_line += f"#!{sound_part}"
                    new_line += f"#@{audio_filename}"

                    processed_lines.append(new_line)
                    continue

                except Exception as e:
                    print(f"  [TTS FAIL] {e} — keeping original line")

            # Fallback — keep unchanged
            processed_lines.append(line)

    asyncio.run(process_lines())

    # Overwrite the script with TTS-tagged version
    with open(script_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(processed_lines))

    print(f"  [TTS] Done — {tts_counter} audio files generated.")


if __name__ == "__main__":
    main()
