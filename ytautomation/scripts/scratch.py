import google.generativeai as genai, os
from dotenv import load_dotenv
load_dotenv('../.env')
genai.configure(api_key=os.getenv('GEMINI_API_KEY'))
model = genai.GenerativeModel('gemini-2.5-flash')
prompt = '''You are writing a YouTube Shorts script for a viral rage-bait debate video.
The video will be pure audio comedy, featuring 2 to 4 distinct meme characters arguing.

AVAILABLE CAST:
- Guy: Dumb but confident, instigator.
- Christopher: Smug, corrects people, gets triggered.
- Aria: Sassy, aggressive, chaotic.
- Eric: Fast-talking, intense, always panicking.
- Roger: Deep voice, deadpan, oblivious.
- Michelle: Passive aggressive, polite but evil.

OUTPUT FORMAT:
TITLE: TITLE HERE #shorts
---
Guy: text
Christopher: text
'''
resp = model.generate_content(prompt)
print(resp.text)
