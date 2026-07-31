import os
from elevenlabs import ElevenLabs

# API Key provided by the user
ELEVENLABS_API_KEY = "AQ.Ab8RN6KOyjLg8SXyHEPWhCcR2W_IQYkFD3PACrazfBRvznY5Iw"

def generate_dialogue_audio(text, character_name, output_dir, filename):
    """
    Generates TTS audio for a specific character's dialogue.
    """
    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, filename)
    
    if os.path.exists(output_path):
        print(f"Audio already exists: {output_path}")
        return output_path
        
    print(f"Generating audio for {character_name}: '{text}'")
    
    # Simple character to voice mapping
    # Using some default ElevenLabs voice IDs (these are generic public ones)
    voice_map = {
        "ash": "pNInz6obpgDQGcFmaJgB", # Adam (deep)
        "pikachu": "EXAVITQu4vr4xnSDxMaL", # Bella (soft)
        "default": "ErXwobaYiN019PkySvjV"  # Antoni
    }
    
    voice_id = voice_map.get(character_name.lower(), voice_map["default"])
    
    try:
        client = ElevenLabs(api_key=ELEVENLABS_API_KEY)
        audio_generator = client.text_to_speech.convert(
            voice_id=voice_id,
            output_format="mp3_44100_128",
            text=text,
            model_id="eleven_multilingual_v2"
        )
        
        with open(output_path, "wb") as f:
            for chunk in audio_generator:
                if chunk:
                    f.write(chunk)
                    
        return output_path
        
    except Exception as e:
        print(f"Error generating audio: {e}")
        # Create a dummy 1-second silent audio file as fallback using moviepy
        from moviepy.editor import AudioClip
        import numpy as np
        
        def make_frame(t):
            return [0, 0] # silence
            
        clip = AudioClip(make_frame, duration=2)
        clip.write_audiofile(output_path, fps=44100, logger=None)
        return output_path

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 3:
        generate_dialogue_audio(sys.argv[1], sys.argv[2], "assets", sys.argv[3])
    else:
        print("Usage: python audio_generator.py <text> <character> <output_filename>")
