import os
import json
from .asset_scraper import download_sprite
from .audio_generator import generate_dialogue_audio

def prepare_assets_for_scene(scene_json, output_dir):
    """
    Parses the vision JSON and prepares all necessary assets (images/audio)
    for the renderer.
    """
    os.makedirs(output_dir, exist_ok=True)
    
    prepared_assets = {
        "background": None,
        "characters": {},
        "audio": []
    }
    
    # Download background
    bg_desc = scene_json.get("background", "pixel art landscape")
    bg_filename = f"bg_{hash(bg_desc)}.png"
    prepared_assets["background"] = download_sprite(bg_desc + " background", output_dir, bg_filename)
    
    # Download character sprites
    for char in scene_json.get("characters", []):
        char_filename = f"char_{char.replace(' ', '_').lower()}.png"
        prepared_assets["characters"][char] = download_sprite(char + " pokemon sprite", output_dir, char_filename)
        
    # Generate audio for dialogue
    for i, line in enumerate(scene_json.get("dialogue", [])):
        char = line.get("character", "Narrator")
        text = line.get("text", "")
        if text:
            audio_filename = f"dialogue_{i}_{char.replace(' ', '_').lower()}.mp3"
            audio_path = generate_dialogue_audio(text, char, output_dir, audio_filename)
            prepared_assets["audio"].append({
                "character": char,
                "text": text,
                "file": audio_path
            })
            
    return prepared_assets

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        with open(sys.argv[1], 'r') as f:
            data = json.load(f)
        assets = prepare_assets_for_scene(data, "assets")
        print(json.dumps(assets, indent=2))
    else:
        print("Usage: python asset_manager.py <scene_json_file>")
