"""
rage_debate_pipeline.py
========================
Generates rage-bait two-voice debate YouTube Shorts -- like the World War I video.

Format:
- Two AI/meme voices arguing about something dumb or controversial
- Voice A (Guy/Curious-Dumb): asks something ridiculous, doubles down, escalates
- Voice B (Christopher/Smart-Smug): gives the correct answer first, then gets triggered
- Ends on a punchline or completely unhinged take
- No Discord UI -- just audio over a dynamic speaker-highlight background

Audio: Microsoft edge-tts (neural voices, free)
Video: moviepy + imageio_ffmpeg (bundled ffmpeg, no install needed)
Script: Gemini AI with strict quality loop -- regenerates until valid

LOOP: Validates script after generation. Regenerates up to MAX_ATTEMPTS times.
"""

import asyncio
import os
import sys
import re
import json
import random
import textwrap
import time

import imageio_ffmpeg
import google.generativeai as genai
from dotenv import load_dotenv
from PIL import Image, ImageDraw, ImageFont
import edge_tts

# Patch moviepy to use imageio bundled ffmpeg so no system ffmpeg needed
os.environ["IMAGEIO_FFMPEG_EXE"] = imageio_ffmpeg.get_ffmpeg_exe()
from moviepy.editor import (
    AudioFileClip, ImageClip,
    concatenate_videoclips,
)

# ----------------------------------------------
# CONFIG
# ----------------------------------------------
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))
GEMINI_KEY = os.getenv("GEMINI_API_KEY", "")
genai.configure(api_key=GEMINI_KEY)

ASSET_ROOT  = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "assets"))
OUTPUT_DIR  = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SCRATCH_DIR = os.path.join(OUTPUT_DIR, "_rage_scratch")
os.makedirs(SCRATCH_DIR, exist_ok=True)

MAX_ATTEMPTS = 5
VIDEO_W, VIDEO_H = 1080, 1920   # vertical 9:16

# ----------------------------------------------
# VOICES
# Two distinct-sounding neural voices that feel like meme archetypes
# ----------------------------------------------
VOICE_A = {"name": "Guy",         "voice": "en-US-GuyNeural",         "rate": "+8%",  "pitch": "+0Hz"}
VOICE_B = {"name": "Christopher", "voice": "en-US-ChristopherNeural", "rate": "+0%",  "pitch": "-4Hz"}
VOICE_MAP = {VOICE_A["name"]: VOICE_A, VOICE_B["name"]: VOICE_B}

# ----------------------------------------------
# TOPIC SEEDS -- variety pool so it never repeats
# ----------------------------------------------
TOPIC_SEEDS = [
    "insisting the Great Wall of China is visible from the moon",
    "claiming the sun is actually cold and we just feel the reflection",
    "arguing sharks are mammals because they are big",
    "insisting Australia doesnt exist and is a government conspiracy",
    "claiming Napoleon was 6 feet tall and historians are lying",
    "saying birds are not real because they charge on power lines",
    "arguing the earth is flat but only in America",
    "insisting the pyramids were built by Americans",
    "claiming we only use 10 percent of our brain and he uses 11",
    "saying gorillas are just big monkeys and science is wrong",
    "insisting lightning never strikes the same place because lightning has loyalty",
    "claiming photosynthesis is when plants eat sunlight like food",
    "saying Thomas Edison invented everything including the sun",
    "arguing the human body has 8 senses and the 8th is rizz",
    "insisting Mount Everest is fake and just a really tall hill",
    "claiming fish dont feel pain so sushi is ethical",
    "arguing that the moon controls WiFi signal strength",
    "insisting that dogs can read minds but choose not to",
    "claiming that the Titanic sinking was staged for insurance",
    "arguing that rainbows are just leaked government lasers",
]

# ----------------------------------------------
# SYSTEM PROMPT
# ----------------------------------------------
SYSTEM_PROMPT = """\
You are writing a YouTube Shorts script for a viral rage-bait debate video.
Two voices argue. No faces, no visuals -- pure audio comedy.

VOICES:
- Guy: curious but confidently wrong. Asks something dumb, doubles down when corrected, gets MORE wrong and unhinged each line. Uses "bro", "wait", "no but", "actually". Escalates to caps.
- Christopher: smug and correct. Starts calm, corrects Guy precisely, then slowly loses it. Gets increasingly sarcastic and done.

SCRIPT RULES:
1. START with Guy saying something confidently wrong -- no intro, no "hey guys", straight into the take.
2. The debate escalates -- Guy gets more unhinged every single exchange, never accepts reality.
3. Christopher corrects 1-2 times then starts roasting Guy hard.
4. LAST LINE must be Guy. Must be a completely insane, unhinged, made-up claim stated with full confidence. This is the punchline.
5. ZERO ChatGPT phrases -- no "thats a great point", "it is important to note", "certainly", "i understand your perspective".
6. Write like real people arguing. Short punchy lines. Mix lowercase and CAPS for Guy when he gets mad.
7. 8 to 14 lines total. Around 140-180 words spoken.

OUTPUT FORMAT (STRICTLY follow this, no extra text before or after):
TITLE: <clickbait title with caps where natural, ends with #shorts>
---
Guy: <line>
Christopher: <line>
Guy: <line>
Christopher: <line>
...
"""

def build_prompt():
    topic = random.choice(TOPIC_SEEDS)
    return SYSTEM_PROMPT + f"\nTOPIC: {topic}\n\nGenerate the script now:"

# ----------------------------------------------
# GENERATION + PARSING
# ----------------------------------------------
def generate_script():
    prompt = build_prompt()
    model = genai.GenerativeModel("gemini-2.5-flash")
    try:
        resp = model.generate_content(
            prompt,
            generation_config=genai.types.GenerationConfig(temperature=1.2, max_output_tokens=600),
        )
        raw = resp.text.strip()
    except Exception as e:
        print(f"  [Gemini ERROR] {e}")
        return None
    return parse_script(raw)


def parse_script(raw):
    lines = raw.strip().splitlines()
    title = ""
    dialogue = []
    in_dialogue = False
    for line in lines:
        line = line.strip()
        if not line:
            continue
        if line.startswith("TITLE:"):
            title = line[len("TITLE:"):].strip()
        elif line == "---":
            in_dialogue = True
        elif in_dialogue:
            m = re.match(r"^(Guy|Christopher)\s*:\s*(.+)$", line, re.IGNORECASE)
            if m:
                spk = "Guy" if m.group(1).lower() == "guy" else "Christopher"
                dialogue.append({"speaker": spk, "text": m.group(2).strip()})
    if not title or len(dialogue) < 6:
        print(f"  [PARSE FAIL] title={bool(title)} lines={len(dialogue)}")
        return None
    return {"title": title, "dialogue": dialogue}

# ----------------------------------------------
# VALIDATION -- the loop that keeps quality tight
# ----------------------------------------------
CHATGPT_PHRASES = [
    "thats a great point", "it is important to note", "in conclusion",
    "i understand your perspective", "you raise a valid", "let me clarify",
    "as an ai", "i should mention", "certainly,", "of course,",
    "great question",
]

def validate_script(script):
    issues = []
    dlg = script["dialogue"]
    if len(dlg) < 8:
        issues.append(f"Too few lines: {len(dlg)} (need 8+)")
    # No 3-in-a-row from same speaker
    for i in range(len(dlg) - 2):
        if dlg[i]["speaker"] == dlg[i+1]["speaker"] == dlg[i+2]["speaker"]:
            issues.append(f"Same speaker 3x in a row at lines {i+1}-{i+3}")
    if dlg and dlg[0]["speaker"] != "Guy":
        issues.append("First line must be from Guy")
    if dlg and dlg[-1]["speaker"] != "Guy":
        issues.append("Last line must be from Guy (the punchline)")
    for entry in dlg:
        low = entry["text"].lower()
        for phrase in CHATGPT_PHRASES:
            if phrase in low:
                issues.append(f"ChatGPT phrase: '{phrase}'")
    christopher_lines = [d for d in dlg if d["speaker"] == "Christopher"]
    if len(christopher_lines) < 3:
        issues.append(f"Christopher too silent: {len(christopher_lines)} lines")
    total_words = sum(len(d["text"].split()) for d in dlg)
    if total_words < 100:
        issues.append(f"Too short: {total_words} words (need 100+)")
    if total_words > 230:
        issues.append(f"Too long: {total_words} words (cap 230)")
    if "#shorts" not in script["title"].lower():
        issues.append("Title missing #shorts")
    return len(issues) == 0, issues

# ----------------------------------------------
# TTS
# ----------------------------------------------
async def synth_line(text, voice_cfg, out_path):
    comm = edge_tts.Communicate(text, voice_cfg["voice"], rate=voice_cfg["rate"], pitch=voice_cfg["pitch"])
    await comm.save(out_path)


async def generate_all_audio(dialogue, out_dir):
    results = []
    tasks = []
    for i, entry in enumerate(dialogue):
        vcfg = VOICE_MAP.get(entry["speaker"], VOICE_A)
        path = os.path.join(out_dir, f"line_{i:03d}_{entry['speaker']}.mp3")
        results.append({**entry, "audio_path": path, "index": i})
        tasks.append(synth_line(entry["text"], vcfg, path))
    await asyncio.gather(*tasks)
    return results

# ----------------------------------------------
# BACKGROUND FRAMES
# ----------------------------------------------
COLOR_BASE    = (15, 15, 20)
COLOR_GUY_ON  = (50, 50, 140)
COLOR_CHRI_ON = (30, 110, 50)
COLOR_OFF     = (25, 25, 35)
TEXT_GUY      = (180, 200, 255)
TEXT_CHRI     = (140, 220, 140)
BAR_Y_A = VIDEO_H // 2 - 220
BAR_Y_B = VIDEO_H // 2 + 60

def _load_font(size):
    try:
        return ImageFont.truetype(os.path.join(ASSET_ROOT, "fonts", "whitney", "bold.ttf"), size)
    except Exception:
        return ImageFont.load_default()


def create_frame(active_speaker, title, out_path):
    img = Image.new("RGB", (VIDEO_W, VIDEO_H), COLOR_BASE)
    draw = ImageDraw.Draw(img)
    # Subtle vignette lines
    for y in range(0, VIDEO_H, 6):
        v = int(abs((y / VIDEO_H) - 0.5) * 25)
        draw.line([(0, y), (VIDEO_W, y)], fill=(v, v, v + 3))

    a_color = COLOR_GUY_ON  if active_speaker == "Guy"         else COLOR_OFF
    b_color = COLOR_CHRI_ON if active_speaker == "Christopher" else COLOR_OFF
    draw.rounded_rectangle([60, BAR_Y_A, VIDEO_W - 60, BAR_Y_A + 110], radius=22, fill=a_color)
    draw.rounded_rectangle([60, BAR_Y_B, VIDEO_W - 60, BAR_Y_B + 110], radius=22, fill=b_color)

    nfont = _load_font(54)
    sfont = _load_font(38)
    draw.text((110, BAR_Y_A + 28), "??  Guy",         font=nfont, fill=TEXT_GUY)
    draw.text((110, BAR_Y_B + 28), "??  Christopher", font=nfont, fill=TEXT_CHRI)

    title_clean = re.sub(r"#\w+", "", title).strip()
    wrapped = textwrap.fill(title_clean, width=30)
    draw.text((60, 80), wrapped, font=sfont, fill=(190, 190, 200))

    img.save(out_path)

# ----------------------------------------------
# VIDEO ASSEMBLY
# ----------------------------------------------
def build_video(audio_entries, script, out_path):
    title = script["title"]
    clips = []
    print("  [VIDEO] Building per-line clips...")
    for entry in audio_entries:
        ap = entry["audio_path"]
        if not os.path.exists(ap):
            print(f"    [WARN] Missing audio: {ap}")
            continue
        audio = AudioFileClip(ap)
        frame_path = os.path.join(SCRATCH_DIR, f"frame_{entry['index']:03d}.png")
        create_frame(entry["speaker"], title, frame_path)
        clip = ImageClip(frame_path).set_duration(audio.duration).set_audio(audio)
        clips.append(clip)

    if not clips:
        print("  [ERROR] No clips to assemble!")
        return False

    print(f"  [VIDEO] Concatenating {len(clips)} clips...")
    final = concatenate_videoclips(clips, method="compose")
    print(f"  [VIDEO] Writing ? {out_path}")
    final.write_videofile(
        out_path, fps=30, codec="libx264", audio_codec="aac",
        ffmpeg_params=["-crf", "23", "-preset", "fast"],
        logger=None,
    )
    final.close()
    for c in clips:
        c.close()
    return True

# ----------------------------------------------
# MAIN
# ----------------------------------------------
def clean_scratch():
    for f in os.listdir(SCRATCH_DIR):
        try:
            os.remove(os.path.join(SCRATCH_DIR, f))
        except Exception:
            pass


def main():
    print("\n" + "=" * 60)
    print("  RAGE DEBATE PIPELINE  -  Two-voice viral debate Short")
    print("=" * 60)

    script = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        print(f"\n[Attempt {attempt}/{MAX_ATTEMPTS}] Generating script from Gemini...")
        script = generate_script()
        if script is None:
            time.sleep(2)
            continue

        print(f"  Title  : {script['title']}")
        print(f"  Lines  : {len(script['dialogue'])}")
        for e in script["dialogue"][:3]:
            print(f"    {e['speaker']}: {e['text'][:80]}")
        print("    ...")

        valid, issues = validate_script(script)
        if not valid:
            print(f"  [FAIL] {len(issues)} issue(s):")
            for iss in issues:
                print(f"    x {iss}")
            script = None
            time.sleep(1)
            continue

        print("  [PASS] Script is valid!")
        break

    if script is None:
        print(f"\n[ABORT] No valid script after {MAX_ATTEMPTS} attempts.")
        return 1

    # Save script JSON
    sjson = os.path.join(OUTPUT_DIR, "rage_debate_script.json")
    with open(sjson, "w", encoding="utf-8") as f:
        json.dump(script, f, indent=2, ensure_ascii=False)
    print(f"\n[SCRIPT] Saved ? {sjson}")
    print("\n[FULL DIALOGUE]")
    print("-" * 50)
    for e in script["dialogue"]:
        print(f"  {e['speaker']}: {e['text']}")
    print("-" * 50)

    # TTS
    print("\n[TTS] Synthesizing audio (all lines in parallel)...")
    clean_scratch()
    audio_entries = asyncio.run(generate_all_audio(script["dialogue"], SCRATCH_DIR))
    print(f"  Done - {len(audio_entries)} clips")

    # Video
    out_path = os.path.join(OUTPUT_DIR, "rage_debate_short.mp4")
    ok = build_video(audio_entries, script, out_path)

    if ok:
        print(f"\n SUCCESS! ? {out_path}")
    else:
        print("\n[ERROR] Video assembly failed.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
