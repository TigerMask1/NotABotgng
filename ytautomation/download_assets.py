"""
download_assets.py — Curated meme asset downloader for the NOTABOT YT pipeline.

Assets are organized into CATEGORIES. The pipeline will pick random files from
each category so every video gets fresh variety automatically.

Run from the ytautomation/ folder:
    python download_assets.py

Requirements: yt-dlp, ffmpeg (already installed)
"""
import os
import subprocess
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# ── SOUNDS ─────────────────────────────────────────────────────────────────────
# Format: (output_name, youtube_url, start_sec, end_sec)
# end_sec=None means download the whole thing
SOUNDS = {
    "funny": [
        ("bruh",           "https://www.youtube.com/shorts/cjDyzNbGn9c",  None, None),
        ("oof",            "https://www.youtube.com/watch?v=p4Gotl9vRGs",  None, None),
        ("nuh_uh",         "https://www.youtube.com/shorts/LiJ1GomCa7c",  None, None),
        ("rizz",           "https://www.youtube.com/shorts/0FTM12QimwA",  None, None),
        ("skull_emoji",    "https://www.youtube.com/shorts/4JNqBBE8PMM",  None, None),
        ("ratio",          "https://www.youtube.com/shorts/k6J7yd7p1k0",  None, None),
        ("no_cap",         "https://www.youtube.com/shorts/8Y9LqCt0NOo",  None, None),
        ("sheesh",         "https://www.youtube.com/shorts/WkxWpHCMpqU",  None, None),
        ("yeet",           "https://www.youtube.com/shorts/G5eBFdK_hS0",  None, None),
        ("big_chungus",    "https://www.youtube.com/watch?v=5-sfG8BV8wU",  0,   3),
    ],
    "dramatic": [
        ("inception_bwaam","https://www.youtube.com/watch?v=WXTBFYjkWWA",  None, None),
        ("suspense",       "https://www.youtube.com/watch?v=N74ZTLXCTDE",  None, None),
        ("to_be_continued","https://www.youtube.com/watch?v=AWIL6Bkfb4U",  None, None),
        ("sad_violin",     "https://www.youtube.com/watch?v=GJIIh-VV1-s",  None, None),
        ("dramatic_chipmunk","https://www.youtube.com/watch?v=a1Y73sPHKxw",None, None),
    ],
    "reaction": [
        ("wow",            "https://www.youtube.com/watch?v=ZNXEbITzLCk",  None, None),
        ("gasp",           "https://www.youtube.com/shorts/7QFVsGnAtno",   None, None),
        ("evil_laugh",     "https://www.youtube.com/watch?v=Kk3mFbZShOc",  None, None),
        ("windows_error",  "https://www.youtube.com/watch?v=Y2dQtL_nf6g",  None, None),
        ("airhorn",        "https://www.youtube.com/watch?v=SBbHG0-TAFI",  None, None),
        ("clapping",       "https://www.youtube.com/watch?v=gQo1h3V04H8",  None, None),
        ("dun_dun_dun",    "https://www.youtube.com/watch?v=OAZKB0MgEXA",  None, None),
    ],
}

# ── CLIPS ──────────────────────────────────────────────────────────────────────
# Format: (output_name, youtube_url, start_sec, end_sec)
CLIPS = {
    "funny": [
        ("cat_typing",      "https://www.youtube.com/watch?v=J---aiyznGQ",  0,  8),
        ("confused_dog",    "https://www.youtube.com/shorts/xVD0nuraqtg",   0,  6),
        ("guy_pointing",    "https://www.youtube.com/shorts/8iBVsNFCi44",   0,  5),
        ("math_lady",       "https://www.youtube.com/shorts/mz2wCw4WYOo",   0,  5),
        ("laughing_baby",   "https://www.youtube.com/watch?v=RP4abiHdQpc",  0,  6),
        ("cat_head_tilt",   "https://www.youtube.com/shorts/z_7M8ySqgfI",   0,  5),
        ("shrek_mirror",    "https://www.youtube.com/shorts/ZzVN6wrHs0E",   0,  5),
        ("minion_laugh",    "https://www.youtube.com/shorts/YWnDdH_tUKs",   0,  5),
    ],
    "dramatic": [
        ("dramatic_turn",   "https://www.youtube.com/shorts/8Nj9BhKGJaA",   0,  5),
        ("slow_walk",       "https://www.youtube.com/shorts/FTlxGHgKd0E",   0,  6),
        ("glare",           "https://www.youtube.com/shorts/C7rp3AuFBc0",   0,  5),
    ],
    "reaction": [
        ("mind_blown",      "https://www.youtube.com/shorts/rKzFiAaRB88",   0,  5),
        ("jaw_drop",        "https://www.youtube.com/shorts/ek7l44MFvng",   0,  5),
        ("shocked_pikachu", "https://www.youtube.com/shorts/Ee7g_h0RIfk",   0,  5),
        ("side_eye_cat",    "https://www.youtube.com/shorts/nw-cFtGpCcA",   0,  5),
    ],
}


def run(cmd):
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"    ⚠  stderr: {result.stderr.strip()[:200]}")
    return result.returncode == 0


def download_sound(name, url, category, start=None, end=None):
    out_dir = os.path.join(BASE_DIR, "assets", "sounds", "mp3", category)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{name}.mp3")
    if os.path.exists(out_path):
        print(f"    [SKIP] {category}/{name}.mp3 already exists")
        return True

    tmp_path = os.path.join(out_dir, f"_tmp_{name}")
    cmd = [
        "yt-dlp",
        "-x", "--audio-format", "mp3", "--audio-quality", "0",
        "--no-playlist", "--quiet", "--no-warnings",
        "-o", f"{tmp_path}.%(ext)s",
        url
    ]
    if start is not None or end is not None:
        section = ""
        if start is not None:
            section += f"*{start}-"
        else:
            section += "*0-"
        if end is not None:
            section += str(end)
        else:
            section += "inf"
        cmd += ["--download-sections", section]
    
    ok = run(cmd)
    # rename if tmp file exists
    for f in os.listdir(out_dir):
        if f.startswith(f"_tmp_{name}"):
            os.rename(os.path.join(out_dir, f), out_path)
            break
    if ok and os.path.exists(out_path):
        print(f"    [OK] {category}/{name}.mp3")
        return True
    else:
        print(f"    [FAIL] {category}/{name} -- failed or unavailable")
        return False


def download_clip(name, url, category, start=None, end=None):
    out_dir = os.path.join(BASE_DIR, "assets", "clips", category)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{name}.mp4")
    if os.path.exists(out_path):
        print(f"    [SKIP] {category}/{name}.mp4 already exists")
        return True

    tmp_path = os.path.join(out_dir, f"_tmp_{name}")
    cmd = [
        "yt-dlp",
        "-f", "bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "--merge-output-format", "mp4",
        "--no-playlist", "--quiet", "--no-warnings",
        "-o", f"{tmp_path}.%(ext)s",
        url
    ]
    if start is not None or end is not None:
        s = start or 0
        section = f"*{s}-{end}" if end else f"*{s}-inf"
        cmd += ["--download-sections", section]

    ok = run(cmd)
    for f in os.listdir(out_dir):
        if f.startswith(f"_tmp_{name}"):
            os.rename(os.path.join(out_dir, f), out_path)
            break
    if ok and os.path.exists(out_path):
        print(f"    [OK] {category}/{name}.mp4")
        return True
    else:
        print(f"    [FAIL] {category}/{name} -- failed or unavailable")
        return False


def main():
    print("\n[SOUNDS] DOWNLOADING SOUNDS...")
    total_ok = 0
    for category, items in SOUNDS.items():
        print(f"\n  [DIR] sounds/{category}/")
        for name, url, start, end in items:
            if download_sound(name, url, category, start, end):
                total_ok += 1

    print("\n[CLIPS] DOWNLOADING CLIPS...")
    for category, items in CLIPS.items():
        print(f"\n  [DIR] clips/{category}/")
        for name, url, start, end in items:
            if download_clip(name, url, category, start, end):
                total_ok += 1

    print(f"\n[DONE] {total_ok} assets downloaded.")
    print("Drop any extra MP3s/MP4s into the category folders and they'll be picked automatically!")


if __name__ == "__main__":
    main()
