"""
download_assets.py -- Curated meme asset downloader for the NOTABOT YT pipeline.

Sources:
  - Sounds: Direct free CDN links (Pixabay, Zapsplat-free, public domain)
  - Clips: Pixabay free stock video (no copyright) + stable YouTube classics

ffmpeg path is hardcoded since winget install needs a shell restart to hit PATH.

Run from the ytautomation/ folder:
    python download_assets.py
"""
import os
import subprocess
import sys
import urllib.request
import shutil

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Hardcode ffmpeg path (winget installed it here, PATH needs shell restart)
FFMPEG_BIN = (
    r"C:\Users\LENOVO\AppData\Local\Microsoft\WinGet\Packages"
    r"\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe"
    r"\ffmpeg-9.0.1-full_build\bin"
)
FFMPEG_EXE = os.path.join(FFMPEG_BIN, "ffmpeg.exe")

# ─────────────────────────────────────────────────────────────────────────────
# SOUNDS
# Format: (output_name, direct_url)
# All from Pixabay free license (no attribution required for video content)
# or public domain sources.
# ─────────────────────────────────────────────────────────────────────────────
SOUNDS = {
    "funny": [
        ("bruh",           "https://cdn.pixabay.com/audio/2022/03/15/audio_cced40d1c9.mp3"),
        ("vine_boom",      "https://cdn.pixabay.com/audio/2021/08/04/audio_c6ccf811f2.mp3"),
        ("nope",           "https://cdn.pixabay.com/audio/2023/04/20/audio_cf4640a6b8.mp3"),
        ("fart",           "https://cdn.pixabay.com/audio/2022/02/07/audio_ec41f62e37.mp3"),
        ("cartoon_slide",  "https://cdn.pixabay.com/audio/2022/11/17/audio_a93ad56f97.mp3"),
        ("boing",          "https://cdn.pixabay.com/audio/2021/08/09/audio_4a03c490d3.mp3"),
        ("record_scratch", "https://cdn.pixabay.com/audio/2022/03/10/audio_c8c8a73467.mp3"),
        ("laugh_track",    "https://cdn.pixabay.com/audio/2022/08/04/audio_2f93064b23.mp3"),
        ("rizz_up",        "https://cdn.pixabay.com/audio/2023/09/28/audio_668fe30fce.mp3"),
        ("tadaa",          "https://cdn.pixabay.com/audio/2022/11/22/audio_f2f8b9c39d.mp3"),
        ("wrong",          "https://cdn.pixabay.com/audio/2024/02/15/audio_e0f2e35889.mp3"),
        ("oh_no",          "https://cdn.pixabay.com/audio/2023/05/16/audio_2e44f2d23c.mp3"),
    ],
    "dramatic": [
        ("inception_horn", "https://cdn.pixabay.com/audio/2022/11/17/audio_febc508520.mp3"),
        ("suspense_sting", "https://cdn.pixabay.com/audio/2022/03/24/audio_5b8f7d1b2f.mp3"),
        ("dun_dun_dun",    "https://cdn.pixabay.com/audio/2021/08/04/audio_12b0c7443c.mp3"),
        ("to_be_continued","https://cdn.pixabay.com/audio/2022/10/30/audio_d1718ab41b.mp3"),
        ("tense_music",    "https://cdn.pixabay.com/audio/2022/08/23/audio_6d7f3f48b2.mp3"),
        ("dramatic_hit",   "https://cdn.pixabay.com/audio/2023/01/18/audio_9f1fedb8ec.mp3"),
        ("sad_trombone",   "https://cdn.pixabay.com/audio/2022/03/15/audio_7d40f99d1c.mp3"),
    ],
    "reaction": [
        ("airhorn",        "https://cdn.pixabay.com/audio/2021/08/09/audio_1447f5d8df.mp3"),
        ("evil_laugh",     "https://cdn.pixabay.com/audio/2022/03/01/audio_bb320d5bae.mp3"),
        ("gasp",           "https://cdn.pixabay.com/audio/2022/10/06/audio_a86a761f69.mp3"),
        ("clapping",       "https://cdn.pixabay.com/audio/2022/07/26/audio_124bfa1c5d.mp3"),
        ("woah",           "https://cdn.pixabay.com/audio/2023/06/14/audio_a3f8e0b0f3.mp3"),
        ("windows_error",  "https://cdn.pixabay.com/audio/2022/01/13/audio_5a3af96dfd.mp3"),
        ("siren",          "https://cdn.pixabay.com/audio/2021/09/06/audio_2516ce0906.mp3"),
    ],
}

# ─────────────────────────────────────────────────────────────────────────────
# CLIPS
# Pixabay free stock videos - no copyright, no watermark, professional quality
# Direct download URLs from Pixabay CDN
# ─────────────────────────────────────────────────────────────────────────────
CLIPS = {
    "funny": [
        # Stable YouTube classics with ffmpeg available for trimming
        ("cat_typing",      "yt:J---aiyznGQ",   0,  7),
        ("surprised_face",  "yt:4VQUWVBDezA",   0,  5),
        ("pointing_guy",    "yt:UJEGfHiS6YE",   0,  5),
        ("nod_yeah",        "yt:AbSehcT19EA",   0,  5),
        ("head_shake_no",   "yt:y8Kyi0WNg40",   0,  5),
    ],
    "dramatic": [
        ("slow_zoom",       "yt:iJ3F_L-bdKE",   0,  5),
        ("eyebrow_raise",   "yt:ssmJAJe8NxI",   0,  5),
        ("intense_stare",   "yt:pR0QCpbGtNM",   0,  5),
    ],
    "reaction": [
        ("mind_blown",      "yt:9CS7j5I6aOc",   0,  5),
        ("jaw_drop",        "yt:XY3roQdP1Ec",   0,  5),
        ("laugh_hard",      "yt:RP4abiHdQpc",   0,  6),
        ("double_take",     "yt:o3mP3mJDL2k",   0,  5),
    ],
}


def download_direct(url, out_path):
    """Download a file from a direct URL."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as r, open(out_path, "wb") as f:
            shutil.copyfileobj(r, f)
        return True
    except Exception as e:
        print(f"    [WARN] Direct download failed: {e}")
        return False


def download_yt(name, yt_id, out_path, start, end, is_audio):
    """Download from YouTube using yt-dlp with hardcoded ffmpeg."""
    tmp_base = out_path.replace(".mp3", "").replace(".mp4", "") + "_tmp"
    ext = "mp3" if is_audio else "mp4"

    if is_audio:
        cmd = [
            "yt-dlp",
            "--ffmpeg-location", FFMPEG_BIN,
            "-x", "--audio-format", "mp3", "--audio-quality", "0",
            "--no-playlist", "--quiet", "--no-warnings",
            "-o", f"{tmp_base}.%(ext)s",
        ]
    else:
        cmd = [
            "yt-dlp",
            "--ffmpeg-location", FFMPEG_BIN,
            "-f", "bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4]/best",
            "--merge-output-format", "mp4",
            "--no-playlist", "--quiet", "--no-warnings",
            "-o", f"{tmp_base}.%(ext)s",
        ]

    if start is not None or end is not None:
        s = start or 0
        e_str = str(end) if end else "inf"
        cmd += ["--download-sections", f"*{s}-{e_str}"]

    cmd.append(f"https://www.youtube.com/watch?v={yt_id}")
    result = subprocess.run(cmd, capture_output=True, text=True)

    # Find and rename tmp file
    out_dir = os.path.dirname(out_path)
    for f in os.listdir(out_dir):
        if f.startswith(os.path.basename(tmp_base)):
            os.rename(os.path.join(out_dir, f), out_path)
            return True

    if result.returncode != 0:
        print(f"    [WARN] {result.stderr.strip()[:150]}")
    return False


def download_sound(name, url, category, start=None, end=None):
    out_dir = os.path.join(BASE_DIR, "assets", "sounds", "mp3", category)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{name}.mp3")

    if os.path.exists(out_path):
        print(f"    [SKIP] {category}/{name}.mp3 already exists")
        return True

    if url.startswith("yt:"):
        ok = download_yt(name, url[3:], out_path, start, end, is_audio=True)
    else:
        ok = download_direct(url, out_path)

    if ok and os.path.exists(out_path):
        size_kb = os.path.getsize(out_path) // 1024
        print(f"    [OK] {category}/{name}.mp3  ({size_kb}KB)")
        return True
    else:
        if os.path.exists(out_path):
            os.remove(out_path)
        print(f"    [FAIL] {category}/{name}")
        return False


def download_clip(name, url_or_id, category, start=None, end=None):
    out_dir = os.path.join(BASE_DIR, "assets", "clips", category)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{name}.mp4")

    if os.path.exists(out_path):
        print(f"    [SKIP] {category}/{name}.mp4 already exists")
        return True

    if url_or_id.startswith("yt:"):
        ok = download_yt(name, url_or_id[3:], out_path, start, end, is_audio=False)
    else:
        ok = download_direct(url_or_id, out_path)

    if ok and os.path.exists(out_path):
        size_kb = os.path.getsize(out_path) // 1024
        print(f"    [OK] {category}/{name}.mp4  ({size_kb}KB)")
        return True
    else:
        if os.path.exists(out_path):
            os.remove(out_path)
        print(f"    [FAIL] {category}/{name}")
        return False


def main():
    print("\n[SOUNDS] DOWNLOADING SOUNDS...")
    s_ok = s_total = 0
    for category, items in SOUNDS.items():
        print(f"\n  [DIR] sounds/{category}/")
        for item in items:
            s_total += 1
            name, url = item[0], item[1]
            start = item[2] if len(item) > 2 else None
            end   = item[3] if len(item) > 3 else None
            if download_sound(name, url, category, start, end):
                s_ok += 1

    print(f"\n  Sounds: {s_ok}/{s_total} downloaded")

    print("\n[CLIPS] DOWNLOADING CLIPS...")
    c_ok = c_total = 0
    for category, items in CLIPS.items():
        print(f"\n  [DIR] clips/{category}/")
        for item in items:
            c_total += 1
            name, url_id, start, end = item
            if download_clip(name, url_id, category, start, end):
                c_ok += 1

    print(f"\n  Clips: {c_ok}/{c_total} downloaded")
    print(f"\n[DONE] Total: {s_ok + c_ok}/{s_total + c_total} assets ready.")
    print("Tip: Drop any extra MP3s/MP4s into the category subfolders and")
    print("     they will be picked up automatically by the pipeline!")


if __name__ == "__main__":
    main()
