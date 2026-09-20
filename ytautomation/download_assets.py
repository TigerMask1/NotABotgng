"""
download_assets.py -- Curated meme asset downloader for the NOTABOT YT pipeline.

Strategy:
  - Sounds: Use yt-dlp YouTube SEARCH (ytsearch1:) to find current working videos
            by name, extract audio, trim to the best part.
  - Clips:  Same search approach for video clips, download + trim with local ffmpeg.

This avoids hardcoding video IDs that constantly go dead/private.

Run from ytautomation/ folder:
    python download_assets.py
"""
import os
import subprocess
import sys
import json

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

FFMPEG_BIN = (
    r"C:\Users\LENOVO\AppData\Local\Microsoft\WinGet\Packages"
    r"\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe"
    r"\ffmpeg-9.0.1-full_build\bin"
)
FFMPEG_EXE = os.path.join(FFMPEG_BIN, "ffmpeg.exe")


# ─────────────────────────────────────────────────────────────────────────────
# SOUNDS
# Format: (output_name, search_query, trim_end_seconds)
# yt-dlp searches YouTube, picks first result, extracts audio, trims it.
# Search queries tuned to find clean, isolated sound effect clips.
# ─────────────────────────────────────────────────────────────────────────────
SOUNDS = {
    "funny": [
        ("vine_boom",      "vine boom sound effect 1 hour",          3),
        ("bruh",           "bruh sound effect meme",                 3),
        ("nuh_uh",         "nuh uh sound effect bell",               3),
        ("fart",           "fart sound effect funny",                3),
        ("boing",          "boing cartoon sound effect",             3),
        ("record_scratch", "record scratch sound effect",            3),
        ("laugh_track",    "laugh track sound effect",               4),
        ("oof",            "oof sound effect roblox",                2),
        ("nope",           "nope buzzer sound effect",               3),
        ("tadaa",          "ta da fanfare sound effect",             4),
        ("wrong",          "wrong answer buzzer sound effect",       3),
        ("oh_no",          "oh no song meme sound effect",           5),
    ],
    "dramatic": [
        ("dun_dun_dun",    "dun dun dun dramatic sound effect",      4),
        ("inception_horn", "inception bwaaaah sound effect",         4),
        ("suspense",       "dramatic suspense sting sound effect",   5),
        ("sad_trombone",   "sad trombone wah wah sound effect",      5),
        ("to_be_cont",     "to be continued meme sound roundabout",  6),
        ("dramatic_hit",   "dramatic hit sound effect orchestra",    4),
    ],
    "reaction": [
        ("airhorn",        "airhorn sound effect",                   3),
        ("evil_laugh",     "evil villain laugh sound effect",        4),
        ("gasp",           "gasp sound effect dramatic",             2),
        ("clapping",       "applause clapping sound effect",         4),
        ("windows_error",  "windows xp error sound",                 3),
        ("siren",          "police siren sound effect short",        4),
        ("woah",           "woah sound effect meme",                 2),
    ],
}

# ─────────────────────────────────────────────────────────────────────────────
# CLIPS
# Format: (output_name, search_query, trim_end_seconds)
# Search for well-known reaction / meme clips
# ─────────────────────────────────────────────────────────────────────────────
CLIPS = {
    "funny": [
        ("cat_typing",     "keyboard cat original",                  8),
        ("math_lady",      "confused math lady meme",                6),
        ("pointing_guy",   "leonardo dicaprio pointing meme",        4),
        ("nod_yes",        "yes nodding approval meme clip",         4),
        ("head_shake_no",  "no head shake meme clip",                4),
        ("spider_man",     "spider man pointing at each other meme", 6),
        ("this_is_fine",   "this is fine dog meme original",         5),
        ("shrek_mirror",   "shrek mirror mirror meme",               5),
    ],
    "dramatic": [
        ("dramatic_zoom",  "dramatic chipmunk original video",       6),
        ("slow_clap",      "slow clap scene movie meme",             6),
        ("intense_stare",  "intense stare meme clip short",          5),
    ],
    "reaction": [
        ("mind_blown",     "mind blown meme gif clip",               5),
        ("jaw_drop",       "jaw drop shocked reaction meme",         5),
        ("laughing_hard",  "laughing hard funny reaction meme",      5),
        ("side_eye",       "side eye chloe original video",          5),
    ],
}


def run_yt_dlp(args):
    """Run yt-dlp via Python module (avoids PATH issues on Windows)."""
    cmd = [sys.executable, "-m", "yt_dlp", "--ffmpeg-location", FFMPEG_BIN] + args
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.returncode, r.stdout, r.stderr


def trim_with_ffmpeg(src, dst, duration):
    """Trim src to first `duration` seconds and save as dst."""
    if not os.path.exists(FFMPEG_EXE):
        return False
    cmd = [
        FFMPEG_EXE, "-y", "-loglevel", "error",
        "-i", src,
        "-t", str(duration),
        "-c", "copy",
        dst
    ]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        # copy failed (codec mismatch) — re-encode
        cmd2 = [
            FFMPEG_EXE, "-y", "-loglevel", "error",
            "-i", src,
            "-t", str(duration),
            dst
        ]
        r2 = subprocess.run(cmd2, capture_output=True)
        return r2.returncode == 0
    return os.path.exists(dst) and os.path.getsize(dst) > 0


def search_and_download_sound(name, query, category, trim_end):
    out_dir = os.path.join(BASE_DIR, "assets", "sounds", "mp3", category)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{name}.mp3")

    if os.path.exists(out_path) and os.path.getsize(out_path) > 2000:
        print(f"    [SKIP] {category}/{name}.mp3")
        return True

    tmp_base = os.path.join(out_dir, f"_tmp_{name}")

    # Search YouTube and download first result as audio
    rc, out, err = run_yt_dlp([
        "-x", "--audio-format", "mp3", "--audio-quality", "0",
        "--no-playlist", "--quiet", "--no-warnings",
        "--match-filter", "duration < 7200",  # skip >2hr videos
        "-o", f"{tmp_base}.%(ext)s",
        f"ytsearch1:{query}"
    ])

    # Find downloaded tmp file
    tmp_file = None
    for f in os.listdir(out_dir):
        if f.startswith(f"_tmp_{name}."):
            tmp_file = os.path.join(out_dir, f)
            break

    if not tmp_file:
        if err.strip():
            print(f"    [WARN] {err.strip()[:120]}")
        print(f"    [FAIL] {category}/{name}")
        return False

    # Trim it
    ok = trim_with_ffmpeg(tmp_file, out_path, trim_end)
    os.remove(tmp_file)

    if ok and os.path.exists(out_path) and os.path.getsize(out_path) > 2000:
        print(f"    [OK] {category}/{name}.mp3  ({os.path.getsize(out_path)//1024}KB)")
        return True

    # Fallback: just rename without trimming
    if tmp_file and not os.path.exists(out_path):
        pass
    print(f"    [FAIL] {category}/{name}")
    return False


def search_and_download_clip(name, query, category, trim_end):
    out_dir = os.path.join(BASE_DIR, "assets", "clips", category)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{name}.mp4")

    if os.path.exists(out_path) and os.path.getsize(out_path) > 10000:
        print(f"    [SKIP] {category}/{name}.mp4")
        return True

    tmp_base = os.path.join(out_dir, f"_tmp_{name}")

    # Search YouTube and download best video
    rc, out, err = run_yt_dlp([
        "-f", "bestvideo[ext=mp4][height<=480]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "--merge-output-format", "mp4",
        "--no-playlist", "--quiet", "--no-warnings",
        "--match-filter", "duration < 600",  # skip videos > 10 min
        "-o", f"{tmp_base}.%(ext)s",
        f"ytsearch1:{query}"
    ])

    tmp_file = None
    for f in os.listdir(out_dir):
        if f.startswith(f"_tmp_{name}."):
            tmp_file = os.path.join(out_dir, f)
            break

    if not tmp_file:
        if err.strip():
            print(f"    [WARN] {err.strip()[:120]}")
        print(f"    [FAIL] {category}/{name}")
        return False

    # Trim to just the interesting part
    ok = trim_with_ffmpeg(tmp_file, out_path, trim_end)
    try:
        os.remove(tmp_file)
    except Exception:
        pass

    if not ok or not os.path.exists(out_path):
        # Fallback: use full video
        rc2, out2, err2 = run_yt_dlp([
            "-f", "best[ext=mp4]/best",
            "--merge-output-format", "mp4",
            "--no-playlist", "--quiet", "--no-warnings",
            "--match-filter", "duration < 600",
            "-o", out_path,
            f"ytsearch1:{query}"
        ])
        if not os.path.exists(out_path):
            print(f"    [FAIL] {category}/{name}")
            return False

    if os.path.getsize(out_path) > 10000:
        print(f"    [OK] {category}/{name}.mp4  ({os.path.getsize(out_path)//1024}KB)")
        return True

    print(f"    [FAIL] {category}/{name}")
    return False


def main():
    print("\n[SOUNDS] DOWNLOADING SOUNDS...\n")
    s_ok = s_total = 0
    for category, items in SOUNDS.items():
        print(f"  [DIR] sounds/{category}/")
        for name, query, trim_end in items:
            s_total += 1
            if search_and_download_sound(name, query, category, trim_end):
                s_ok += 1
        print()

    print(f"  Sounds: {s_ok}/{s_total}\n")

    print("[CLIPS] DOWNLOADING CLIPS...\n")
    c_ok = c_total = 0
    for category, items in CLIPS.items():
        print(f"  [DIR] clips/{category}/")
        for name, query, trim_end in items:
            c_total += 1
            if search_and_download_clip(name, query, category, trim_end):
                c_ok += 1
        print()

    print(f"  Clips: {c_ok}/{c_total}")
    total = s_ok + c_ok
    grand = s_total + c_total
    print(f"\n[DONE] {total}/{grand} assets ready.")
    print("Tip: Drop any MP3/MP4 into the category subfolders to add more anytime!")


if __name__ == "__main__":
    main()
