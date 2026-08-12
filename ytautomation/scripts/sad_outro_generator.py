"""
sad_outro_generator.py
----------------------
Generates a 3-second vertical (1080x1920) MP4 outro clip with:
  - Pure black background
  - Centered self-deprecating white text with fade in/out
  - Subtle background music from assets/sounds/mp3/

Run once to produce:
    ../assets/outros/sad_outro.mp4

Usage:
    python sad_outro_generator.py
"""

# ---------------------------------------------------------------------------
# Pillow 10+ compatibility
# ---------------------------------------------------------------------------
from PIL import Image as _PIL_Image
if not hasattr(_PIL_Image, 'ANTIALIAS'):
    _PIL_Image.ANTIALIAS = _PIL_Image.LANCZOS

import os
import random

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from moviepy.editor import VideoClip, AudioFileClip, CompositeAudioClip

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
WIDTH, HEIGHT = 1080, 1920
DURATION = 4.0          # slightly longer so music has time to breathe
FPS = 24

FADE_IN_END    = 0.6
FADE_OUT_START = 3.2

MESSAGES = [
    "everyone says discord content\ndoesn't work in 2026...\nhelp me",
    "nobody watches these\nbut i keep making them...\nwhy",
    "pls just one sub...\ni'm begging u",
    "they said bots can't be funny.\nthey were right.\nsubscribe anyway",
    "i make these every day\nand still can't afford\na better pc 😭",
]

FONT_SIZE = 52

# Background music candidates (from assets/sounds/mp3/) — pick softest/most emotional
MUSIC_CANDIDATES = [
    'softmessage.mp3',   # soft, ambient — perfect for sad outro
    'hehascome.mp3',     # dramatic/ominous — works for dark comedy
    'confusion.mp3',     # confused helpless vibe
]

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ASSETS_DIR = os.path.join(SCRIPT_DIR, '..', 'assets')
FONTS_DIR  = os.path.join(ASSETS_DIR, 'fonts')
SOUNDS_DIR = os.path.join(ASSETS_DIR, 'sounds', 'mp3')


# ---------------------------------------------------------------------------
# Font helper
# ---------------------------------------------------------------------------
def _find_font(size: int):
    preferred = [
        os.path.join(FONTS_DIR, 'whitney', 'medium.ttf'),
        os.path.join(FONTS_DIR, 'whitney', 'semibold.ttf'),
        os.path.join(FONTS_DIR, 'whitney', 'bold.ttf'),
    ]
    for p in preferred:
        if os.path.isfile(p):
            return ImageFont.truetype(p, size)
    if os.path.isdir(FONTS_DIR):
        for root, _, files in os.walk(FONTS_DIR):
            for fname in files:
                if fname.lower().endswith('.ttf'):
                    return ImageFont.truetype(os.path.join(root, fname), size)
    return ImageFont.load_default()


# ---------------------------------------------------------------------------
# Word-wrap helper
# ---------------------------------------------------------------------------
def _wrap(text, font, max_width):
    dummy = Image.new('RGB', (1, 1))
    draw  = ImageDraw.Draw(dummy)
    words, lines, current = text.split(), [], ''
    for word in words:
        trial = (current + ' ' + word).strip()
        w = draw.textbbox((0, 0), trial, font=font)[2]
        if w <= max_width:
            current = trial
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return '\n'.join(lines)


# ---------------------------------------------------------------------------
# Frame factory
# ---------------------------------------------------------------------------
def _make_frame_factory(message: str):
    font    = _find_font(FONT_SIZE)
    wrapped = _wrap(message, font, 940)

    probe = Image.new('RGBA', (WIDTH, HEIGHT), (0, 0, 0, 0))
    draw  = ImageDraw.Draw(probe)
    bbox  = draw.multiline_textbbox((0, 0), wrapped, font=font, align='center')
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    text_x = (WIDTH  - text_w) // 2
    text_y = (HEIGHT - text_h) // 2

    # Small "subscribe" nudge below the main text
    font_small = _find_font(30)
    sub_text   = "-- NOTABOT  |  one sub won't hurt... right?"
    sub_bbox   = draw.textbbox((0, 0), sub_text, font=font_small)
    sub_x      = (WIDTH - (sub_bbox[2] - sub_bbox[0])) // 2
    sub_y      = text_y + text_h + 50

    def make_frame(t: float) -> np.ndarray:
        if t <= FADE_IN_END:
            alpha = t / FADE_IN_END
        elif t >= FADE_OUT_START:
            alpha = (DURATION - t) / (DURATION - FADE_OUT_START)
        else:
            alpha = 1.0
        alpha      = max(0.0, min(1.0, alpha))
        text_alpha = int(alpha * 255)
        sub_alpha  = int(alpha * 160)   # slightly dimmer for the sub line

        bg         = Image.new('RGB', (WIDTH, HEIGHT), (0, 0, 0))
        text_layer = Image.new('RGBA', (WIDTH, HEIGHT), (0, 0, 0, 0))
        tdraw      = ImageDraw.Draw(text_layer)

        # Main sad text
        tdraw.multiline_text(
            (text_x, text_y), wrapped,
            font=font, fill=(255, 255, 255, text_alpha), align='center',
        )
        # "subscribe" nudge line
        tdraw.text(
            (sub_x, sub_y), sub_text,
            font=font_small, fill=(140, 140, 140, sub_alpha),
        )

        composite = Image.alpha_composite(bg.convert('RGBA'), text_layer).convert('RGB')
        return np.array(composite)

    return make_frame


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    message = random.choice(MESSAGES)
    print(f'[sad_outro] Using: "{message.splitlines()[0]}..."')

    make_frame = _make_frame_factory(message)
    clip = VideoClip(make_frame, duration=DURATION)

    # ── Background music ──────────────────────────────────────────────────────
    music_clip = None
    for candidate in MUSIC_CANDIDATES:
        path = os.path.join(SOUNDS_DIR, candidate)
        if os.path.isfile(path):
            try:
                raw = AudioFileClip(path)
                # Loop or trim to match video duration, then fade out
                if raw.duration < DURATION:
                    # Just use what we have, no looping needed for 4s
                    music_clip = raw.volumex(0.25).audio_fadeout(0.8)
                else:
                    music_clip = raw.subclip(0, DURATION).volumex(0.25).audio_fadeout(0.8)
                print(f'[sad_outro] Music: {candidate}')
                break
            except Exception as e:
                print(f'[sad_outro] Could not load {candidate}: {e}')

    if music_clip:
        clip = clip.set_audio(music_clip)

    # ── Output ────────────────────────────────────────────────────────────────
    outro_dir   = os.path.join(ASSETS_DIR, 'outros')
    os.makedirs(outro_dir, exist_ok=True)
    output_path = os.path.join(outro_dir, 'sad_outro.mp4')

    clip.write_videofile(
        output_path,
        fps=FPS,
        codec='libx264',
        audio_codec='aac',
        logger='bar',
    )
    print('sad_outro.mp4 generated successfully!')


if __name__ == '__main__':
    main()
