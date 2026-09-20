import os
import sys
import argparse
import asyncio
import edge_tts
from moviepy.editor import AudioFileClip
import re

VOICE_MAP = {
    'notabot': {'voice': 'en-US-GuyNeural', 'rate': '+15%', 'pitch': '+5Hz'},
    'ducky': {'voice': 'en-GB-RyanNeural', 'rate': '+25%', 'pitch': '+15Hz'},
    'dumby': {'voice': 'en-US-SteffanNeural', 'rate': '-10%', 'pitch': '-15Hz'},
    'fatas': {'voice': 'en-AU-WilliamNeural', 'rate': '+0%', 'pitch': '+0Hz'},
}
DEFAULT_VOICE = {'voice': 'en-US-ChristopherNeural', 'rate': '+10%', 'pitch': '+0Hz'}

async def generate_audio(text, output_path, voice_config):
    communicate = edge_tts.Communicate(
        text, 
        voice_config['voice'], 
        rate=voice_config.get('rate', '+0%'), 
        pitch=voice_config.get('pitch', '+0Hz')
    )
    await communicate.save(output_path)

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
            if not line.strip() or line.startswith('#'):
                processed_lines.append(line)
                continue

            if line.endswith(':'):
                current_char = line[:-1].strip().lower()
                processed_lines.append(line)
                continue

            # It's a dialogue line. Format is like: text$^duration#!sound
            # Or just text
            text_part = line
            duration_part = ""
            sound_part = ""

            if '$^' in text_part:
                parts = text_part.split('$^', 1)
                text_part = parts[0]
                rest = parts[1]
                if '#!' in rest:
                    d_parts = rest.split('#!', 1)
                    duration_part = d_parts[0]
                    sound_part = d_parts[1]
                else:
                    duration_part = rest
            elif '#!' in text_part:
                parts = text_part.split('#!', 1)
                text_part = parts[0]
                sound_part = parts[1]

            # Generate TTS if text is not empty and only contains letters/numbers
            clean_text = text_part.strip()
            # Clean emojis or weird chars out of text for the TTS engine
            tts_text = re.sub(r'[^\w\s\.,!\?\'"-]', '', clean_text)
            
            if len(tts_text) > 1:
                tts_counter += 1
                audio_filename = f"tts_{tts_counter}.mp3"
                audio_path = os.path.join(tts_dir, audio_filename)
                
                v_config = VOICE_MAP.get(current_char, DEFAULT_VOICE)
                print(f"Generating TTS for {current_char}: {tts_text}")
                
                try:
                    await generate_audio(tts_text, audio_path, v_config)
                    # Get exact length of generated audio
                    clip = AudioFileClip(audio_path)
                    new_duration = round(clip.duration + 0.3, 2)  # add 0.3s padding for natural pause
                    clip.close()
                    
                    # Reconstruct line with exact duration and audio tag
                    new_line = f"{clean_text}$^{new_duration}#!{sound_part}#@{audio_filename}"
                    processed_lines.append(new_line)
                    continue
                except Exception as e:
                    print(f"Failed to generate TTS: {e}")
            
            processed_lines.append(line)

    asyncio.run(process_lines())

    # Save over the script
    with open(script_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(processed_lines))

if __name__ == "__main__":
    main()
