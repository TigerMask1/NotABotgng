import os
import sys
import argparse
import asyncio
import edge_tts
from moviepy.editor import AudioFileClip
import re

# ── VOICE MAP ─────────────────────────────────────────────────────────────────
# Rate = speech speed. Pitch = Hz shift. Go extreme for comedy.
# edge_tts pitch is in Hz relative. +50Hz = chipmunk. -50Hz = demon lord.
VOICE_MAP = {
    # NOTABOT: deep, aggressive, fast — sounds genuinely angry and unhinged
    'notabot':  {'voice': 'en-US-GuyNeural',       'rate': '+25%', 'pitch': '-30Hz'},
    # ducky: high pitched, panicked, fast — sounds like he's about to cry
    'ducky':    {'voice': 'en-GB-RyanNeural',       'rate': '+35%', 'pitch': '+40Hz'},
    # dumby: very slow, very deep, confused — sounds genuinely stupid
    'dumby':    {'voice': 'en-US-SteffanNeural',    'rate': '-30%', 'pitch': '-45Hz'},
    # fatas: extremely chill, slow, monotone — like talking in his sleep
    'fatas':    {'voice': 'en-AU-WilliamNeural',    'rate': '-20%', 'pitch': '-10Hz'},
    # chatgpt: weirdly cheerful, fast, slightly high — passive aggressive robot
    'chatgpt':  {'voice': 'en-US-AvaNeural',        'rate': '+20%', 'pitch': '+20Hz'},
    # groq: extremely fast, sharp — sounds like a speedrunner
    'groq':     {'voice': 'en-US-AndrewNeural',     'rate': '+50%', 'pitch': '+5Hz'},
    # claude: slow, smug, slightly high — condescending professor
    'claude':   {'voice': 'en-US-BrianNeural',      'rate': '-10%', 'pitch': '+15Hz'},
}
DEFAULT_VOICE = {'voice': 'en-US-ChristopherNeural', 'rate': '+10%', 'pitch': '+0Hz'}


async def generate_audio(text, output_path, voice_config):
    communicate = edge_tts.Communicate(
        text,
        voice_config['voice'],
        rate=voice_config.get('rate', '+0%'),
        pitch=voice_config.get('pitch', '+0Hz'),
    )
    await communicate.save(output_path)


def clean_for_tts(text: str) -> str:
    """Strip script formatting tags, emojis, and markdown junk — leave only speakable text."""
    # Remove ALL CAPS formatting markers but keep the words (they're expressive anyway)
    # Strip emoji unicode ranges
    text = re.sub(r'[^\x00-\x7F]+', '', text)
    # Strip markdown bold/italic remnants
    text = re.sub(r'[*_`~]', '', text)
    # Collapse multiple spaces
    text = re.sub(r'\s+', ' ', text).strip()
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

            # Blank lines / comment lines / title lines — pass through unchanged
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
                # right could be: "1.5#!vine_boom" or "1.5#!vine_boom#@tts_1.mp3"
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

            # If a TTS file was already tagged (re-run scenario), keep the line
            if existing_tts:
                processed_lines.append(line)
                continue

            tts_text = clean_for_tts(text_part)

            if len(tts_text) > 1 and current_char is not None:
                tts_counter += 1
                audio_filename = f"tts_{tts_counter}.mp3"
                audio_path = os.path.join(tts_dir, audio_filename)

                v_config = VOICE_MAP.get(current_char, DEFAULT_VOICE)
                print(f"  [TTS] {current_char} ({v_config['voice']} {v_config['rate']} {v_config['pitch']}): {tts_text[:60]}")

                try:
                    await generate_audio(tts_text, audio_path, v_config)

                    clip = AudioFileClip(audio_path)
                    # Use exact TTS duration + tiny padding — the meme sound fires separately
                    tts_duration = round(clip.duration + 0.2, 2)
                    clip.close()

                    # Use whichever is longer: script duration or TTS duration
                    try:
                        script_duration = float(duration_part) if duration_part else 1.5
                    except ValueError:
                        script_duration = 1.5
                    final_duration = max(script_duration, tts_duration)

                    # Rebuild the line: text$^duration#!sound#@tts_file
                    new_line = f"{text_part.strip()}$^{final_duration}"
                    if sound_part:
                        new_line += f"#!{sound_part}"
                    new_line += f"#@{audio_filename}"

                    processed_lines.append(new_line)
                    continue

                except Exception as e:
                    print(f"  [TTS FAIL] {e} — keeping original line")

            # Fallback — keep line unchanged
            processed_lines.append(line)

    asyncio.run(process_lines())

    # Overwrite the script with TTS-tagged version
    with open(script_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(processed_lines))

    print(f"  [TTS] Done — {tts_counter} audio files generated.")


if __name__ == "__main__":
    main()
