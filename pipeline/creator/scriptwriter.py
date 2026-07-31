import os
import json
from google import genai
from google.genai import types

def write_script(prompt, knowledge_base_path):
    """
    Generates a script for an original Gumbino-style video using Gemini,
    heavily influenced by the learned knowledge base.
    """
    print(f"Drafting script for prompt: '{prompt}'...")
    
    # Load learned style
    style_context = ""
    if os.path.exists(knowledge_base_path):
        with open(knowledge_base_path, 'r') as f:
            kb = json.load(f)
            style_context = f"""
            Follow these stylistic guidelines extracted from actual Gumbino videos:
            - Tropes: {', '.join(kb.get('tropes', []))}
            - Pacing: {', '.join(kb.get('pacing', []))}
            - Visual Gags: {', '.join(kb.get('visual_gags', []))}
            - Audio Cues: {', '.join(kb.get('audio_cues_implied', []))}
            """
    else:
        print("Warning: Knowledge base not found. Using default style.")
        style_context = "Use dark, cynical, video game parody humor."

    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        print("Warning: GOOGLE_API_KEY not found. Returning mock script.")
        return mock_script()

    try:
        client = genai.Client(api_key=api_key)
        
        full_prompt = f"""
        You are an autonomous video director generating a script for a new animated parody video in the exact style of the YouTube channel Gumbino.
        
        USER PROMPT: {prompt}
        
        STYLE GUIDELINES:
        {style_context}
        
        Output a strictly formatted JSON array representing a sequence of 5-second scenes.
        For each scene, provide:
        - "background": Description of the background.
        - "characters": List of character names present.
        - "dialogue": Array of objects {{"character": "name", "text": "dialogue"}}. Keep dialogue short enough for 5 seconds.
        - "actions": What the characters do visually.
        
        Example Output:
        [
            {{
                "background": "Green hill zone",
                "characters": ["Sonic", "Tails"],
                "dialogue": [{{"character": "Sonic", "text": "I'm so fast!"}}],
                "actions": ["Sonic runs in place."]
            }}
        ]
        
        Output ONLY valid JSON.
        """

        response = client.models.generate_content(
            model='gemini-1.5-pro',
            contents=[full_prompt],
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
            )
        )
        
        script = json.loads(response.text)
        print("Script generated successfully!")
        return script

    except Exception as e:
        print(f"Error generating script: {e}")
        return mock_script()

def mock_script():
    return [
        {
            "background": "Office desk",
            "characters": ["Mario", "Luigi"],
            "dialogue": [
                {"character": "Mario", "text": "Luigi, the IRS is auditing the Mushroom Kingdom."}
            ],
            "actions": ["Mario slams papers on desk."]
        },
        {
            "background": "Office desk",
            "characters": ["Mario", "Luigi"],
            "dialogue": [
                {"character": "Luigi", "text": "Mama mia... did you claim Yoshi as a dependent?"}
            ],
            "actions": ["Luigi looks terrified."]
        }
    ]

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 2:
        res = write_script(sys.argv[1], sys.argv[2])
        print(json.dumps(res, indent=2))
    else:
        print("Usage: python scriptwriter.py <prompt> <knowledge_base_path>")
