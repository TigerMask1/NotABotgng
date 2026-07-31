import os
import json
from google import genai
from google.genai import types

# Assuming GOOGLE_API_KEY is set in the environment
# Or passed in securely.

def analyze_sprite_sheet(sprite_sheet_path):
    """
    Analyzes a sprite sheet (grid of video frames) using a Vision LLM (Gemini 1.5 Pro).
    Returns a JSON structure describing the characters, actions, and background.
    """
    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        print("Warning: GOOGLE_API_KEY not found in environment. Returning mock data.")
        return mock_response(sprite_sheet_path)

    try:
        client = genai.Client(api_key=api_key)
        
        prompt = """
        Analyze this sprite sheet (a grid of frames from a 5-second video clip).
        This clip is in the style of a pixel-art or video game parody animation (like Gumbino).
        
        Please provide a highly structured JSON response detailing:
        1. "background": A brief description of the environment/background.
        2. "characters": A list of characters present in the scene.
        3. "dialogue": Any inferred dialogue or text on screen.
        4. "actions": What happens across these frames (who attacks who, who moves where).
        
        Ensure the output is ONLY valid JSON matching this structure:
        {
            "background": "string",
            "characters": ["string", "string"],
            "dialogue": [{"character": "string", "text": "string"}],
            "actions": ["string", "string"]
        }
        """

        # Upload the file
        print(f"Uploading {sprite_sheet_path} to Gemini API...")
        file_obj = client.files.upload(file=sprite_sheet_path)

        print("Requesting analysis...")
        response = client.models.generate_content(
            model='gemini-1.5-pro',
            contents=[file_obj, prompt],
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
            )
        )
        
        # Cleanup
        client.files.delete(name=file_obj.name)

        return json.loads(response.text)

    except Exception as e:
        print(f"Error during Vision API call: {e}")
        return mock_response(sprite_sheet_path)

def mock_response(sprite_sheet_path):
    """Returns a mock response for testing without an API key."""
    return {
        "background": "Pokemon battle arena",
        "characters": ["Ash", "Pikachu", "Evil Squirtle"],
        "dialogue": [
            {"character": "Ash", "text": "Pikachu, use Thunderbolt!"},
            {"character": "Evil Squirtle", "text": "Foolish boy..."}
        ],
        "actions": [
            "Ash points forward commandingly.",
            "Pikachu charges electricity.",
            "Evil Squirtle stands menacingly, ignoring the attack."
        ]
    }

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        result = analyze_sprite_sheet(sys.argv[1])
        print(json.dumps(result, indent=2))
    else:
        print("Usage: python vision_analyzer.py <path_to_spritesheet>")
