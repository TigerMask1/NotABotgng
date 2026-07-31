import os
import json
from google import genai
from google.genai import types

def extract_style_from_sprites(sprite_sheet_path, knowledge_base_path):
    """
    Analyzes a sprite sheet to extract Gumbino's humor, pacing, and visual style,
    and updates the local knowledge base.
    """
    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        print("Warning: GOOGLE_API_KEY not found in environment. Returning mock data.")
        return update_knowledge_base_mock(knowledge_base_path)

    try:
        client = genai.Client(api_key=api_key)
        
        prompt = """
        You are analyzing a 5-second chunk (represented as a grid of frames) from a Gumbino YouTube video.
        Gumbino videos are animated parodies of video games (like Pokemon/Mario) known for cynical, dark, or absurd humor.
        
        Analyze these frames and extract "Style Directives". Do NOT just describe the scene. Tell me HOW the scene is constructed to be funny or engaging in the Gumbino style.
        
        Provide a structured JSON output with the following keys:
        1. "tropes": List of character tropes observed (e.g., "Ash is evil/arrogant", "Squirtle wears sunglasses").
        2. "pacing": Observations on timing (e.g., "Fast cuts", "Long awkward silence before a punchline").
        3. "visual_gags": Any visual jokes (e.g., "Exaggerated facial expressions", "Breaking the 4th wall").
        4. "audio_cues_implied": What kind of sound effects or voice tones seem to fit this action (e.g., "Loud boom", "Sarcastic tone").
        
        Output valid JSON only.
        """

        print(f"Analyzing {sprite_sheet_path} for stylistic elements...")
        file_obj = client.files.upload(file=sprite_sheet_path)

        response = client.models.generate_content(
            model='gemini-1.5-pro',
            contents=[file_obj, prompt],
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
            )
        )
        
        client.files.delete(name=file_obj.name)
        
        extracted_data = json.loads(response.text)
        return update_knowledge_base(knowledge_base_path, extracted_data)

    except Exception as e:
        print(f"Error during extraction: {e}")
        return update_knowledge_base_mock(knowledge_base_path)

def update_knowledge_base(kb_path, new_data):
    """Merges new stylistic findings into the persistent knowledge base."""
    if os.path.exists(kb_path):
        with open(kb_path, 'r') as f:
            try:
                kb = json.load(f)
            except json.JSONDecodeError:
                kb = {"tropes": [], "pacing": [], "visual_gags": [], "audio_cues_implied": []}
    else:
        kb = {"tropes": [], "pacing": [], "visual_gags": [], "audio_cues_implied": []}
        
    for key in kb.keys():
        if key in new_data:
            # Add unique items only
            for item in new_data[key]:
                if item not in kb[key]:
                    kb[key].append(item)
                    
    with open(kb_path, 'w') as f:
        json.dump(kb, f, indent=4)
        
    print(f"Knowledge Base updated at {kb_path}")
    return kb

def update_knowledge_base_mock(kb_path):
    mock_data = {
        "tropes": ["Protagonist is actually the villain", "NPCs act like real humans trapped in a game"],
        "pacing": ["Rapid-fire dialogue followed by awkward silence"],
        "visual_gags": ["Sprite stretches horizontally when screaming"],
        "audio_cues_implied": ["Sarcastic sigh", "Vine boom sound effect"]
    }
    return update_knowledge_base(kb_path, mock_data)

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 2:
        extract_style_from_sprites(sys.argv[1], sys.argv[2])
    else:
        print("Usage: python style_extractor.py <spritesheet_path> <knowledge_base_path>")
