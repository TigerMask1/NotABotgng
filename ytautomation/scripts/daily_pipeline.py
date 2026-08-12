"""
daily_pipeline.py
-----------------
Master daily runner for the NOTABOT Discord content factory.

Runs the full pipeline once per day:
  1. Generate 5 different short scripts (20-25 msgs each)
  2. Compile each into a vertical short (vertical_short_1.mp4 … vertical_short_5.mp4)
  3. Generate 1 long-form script (65-80 msgs)
  4. Compile into a 10-min video (final_long.mp4)
  5. Generate a click-bait thumbnail for the long video
  6. Generate the sad outro (if not already present)

Usage:
    python daily_pipeline.py              # Full run
    python daily_pipeline.py --shorts-only  # Only make the 5 shorts
    python daily_pipeline.py --long-only    # Only make the long video
"""

import os
import sys
import shutil
import argparse
import datetime
import subprocess

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ASSETS_DIR = os.path.join(SCRIPT_DIR, '..', 'assets')
OUTPUTS_DIR = os.path.join(SCRIPT_DIR, '..', 'output', datetime.datetime.now().strftime('%Y-%m-%d'))

NUM_SHORTS = 5


def _run_py(script_name, extra_args=None):
    """Run a sibling script with the current Python interpreter."""
    cmd = [sys.executable, os.path.join(SCRIPT_DIR, script_name)]
    if extra_args:
        cmd.extend(extra_args)
    print(f"\n  ▶ {' '.join(cmd)}\n")
    result = subprocess.run(cmd, cwd=SCRIPT_DIR)
    if result.returncode != 0:
        print(f"  ✗ {script_name} failed (exit {result.returncode})")
        return False
    return True


def _ensure_sad_outro():
    outro_path = os.path.join(ASSETS_DIR, 'outros', 'sad_outro.mp4')
    if os.path.exists(outro_path):
        print("[daily] ✓ sad_outro.mp4 already exists — skipping generation.")
        return
    print("[daily] Generating sad outro clip...")
    _run_py('sad_outro_generator.py')


def _clean_chat():
    chat_dir = os.path.join(SCRIPT_DIR, '..', 'chat')
    if os.path.exists(chat_dir):
        shutil.rmtree(chat_dir)


def _save_output(src, dest_name):
    os.makedirs(OUTPUTS_DIR, exist_ok=True)
    dest = os.path.join(OUTPUTS_DIR, dest_name)
    if os.path.isfile(src):
        shutil.copy2(src, dest)
        print(f"[daily] ✓ Saved → output/{datetime.datetime.now().strftime('%Y-%m-%d')}/{dest_name}")
    else:
        print(f"[daily] ⚠ Expected output not found: {src}")


def make_shorts():
    print(f"\n{'═'*60}")
    print(f"  SHORTS PIPELINE — generating {NUM_SHORTS} shorts")
    print(f"{'═'*60}")

    for i in range(1, NUM_SHORTS + 1):
        print(f"\n── Short {i}/{NUM_SHORTS} ──────────────────────────────────")

        # 1. Try to process a real clip from the queue first
        print("  Checking youtube_queue for real clips...")
        cmd = [sys.executable, os.path.join(SCRIPT_DIR, 'process_queue.py')]
        result = subprocess.run(cmd, capture_output=True, text=True, cwd=SCRIPT_DIR)
        
        ok = False
        if result.returncode == 0 and "SUCCESS" in result.stdout:
            print("  ✓ Processed real clip from queue.")
            ok = True
        else:
            print("  - Queue empty or failed. Falling back to random script generator.")
            ok = _run_py('generate_script.py')
            
        if not ok:
            print(f"  ✗ Skipping short {i} due to script gen failure.")
            continue

        # 2. Compile (auto_main will also generate thumbnail — skip for shorts)
        ok = _run_py('auto_main.py', ['--no-thumbnail'])
        if not ok:
            print(f"  ✗ Skipping short {i} due to compile failure.")
            continue

        # 3. Save output with numbered name
        _clean_chat()
        src = os.path.join(SCRIPT_DIR, '..', 'vertical_short.mp4')
        _save_output(src, f'short_{i:02d}.mp4')

        # Also save the script so you can reference what's in each short
        script_src = os.path.join(ASSETS_DIR, 'example', 'generated_script.txt')
        _save_output(script_src, f'short_{i:02d}_script.txt')

    print(f"\n[daily] ✓ All {NUM_SHORTS} shorts complete.")


def make_long_video():
    print(f"\n{'═'*60}")
    print(f"  LONG VIDEO PIPELINE — generating 10-min video")
    print(f"{'═'*60}")

    # 1. Generate long script
    ok = _run_py('generate_script.py', ['--long'])
    if not ok:
        print("  ✗ Long video script generation failed. Aborting long video.")
        return

    # 2. Compile (auto_main will also generate thumbnail automatically)
    ok = _run_py('auto_main.py', ['--long'])
    if not ok:
        print("  ✗ Long video compile failed.")
        return

    _clean_chat()

    # 3. Save outputs
    _save_output(os.path.join(SCRIPT_DIR, '..', 'final_long.mp4'), 'long_video.mp4')
    _save_output(os.path.join(ASSETS_DIR, 'example', 'generated_long_script.txt'), 'long_video_script.txt')

    # 4. Save thumbnail
    today = datetime.datetime.now().strftime('%Y%m%d')
    _save_output(os.path.join(ASSETS_DIR, 'thumbnails', f'thumb_{today}.png'), 'thumbnail.png')

    print("[daily] ✓ Long video pipeline complete.")


def main():
    parser = argparse.ArgumentParser(description='Daily NOTABOT content pipeline.')
    parser.add_argument('--shorts-only', action='store_true', help='Only generate the 5 shorts')
    parser.add_argument('--long-only',   action='store_true', help='Only generate the long video')
    args = parser.parse_args()

    start_time = datetime.datetime.now()
    print(f"\n{'═'*60}")
    print(f"  NOTABOT DAILY PIPELINE  |  {start_time.strftime('%Y-%m-%d %H:%M')}")
    print(f"{'═'*60}")

    # Always ensure the sad outro exists first
    _ensure_sad_outro()

    if not args.long_only:
        make_shorts()

    if not args.shorts_only:
        make_long_video()

    elapsed = datetime.datetime.now() - start_time
    print(f"\n{'═'*60}")
    print(f"  ALL DONE  |  Total time: {str(elapsed).split('.')[0]}")
    print(f"  Output folder: output/{start_time.strftime('%Y-%m-%d')}/")
    print(f"{'═'*60}\n")


if __name__ == '__main__':
    main()
