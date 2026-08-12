import os
import sys
import argparse
import datetime

# Allow relative imports when running from scripts/
sys.path.insert(0, os.path.dirname(__file__))

from generate_chat import save_images
from compile_images import gen_vid

def main():
    parser = argparse.ArgumentParser(description='Generate a Discord video (short or long).')
    parser.add_argument('--long', action='store_true',
                        help='Use the long-form script (generated_long_script.txt) for a ~10-min video')
    parser.add_argument('--no-thumbnail', action='store_true',
                        help='Skip thumbnail generation')
    args = parser.parse_args()

    # ── Pick the right script file ─────────────────────────────────────────────
    script_name = 'generated_long_script.txt' if args.long else 'generated_script.txt'
    script_file = os.path.join('..', 'assets', 'example', script_name)

    if not os.path.isfile(script_file):
        print(f"Error: script not found → {script_file}")
        print("Tip: run  python generate_script.py --long  first to generate the script.")
        sys.exit(1)

    # ── Output file name ───────────────────────────────────────────────────────
    output_name = 'final_long.mp4' if args.long else 'vertical_short.mp4'
    final_video = os.path.join('..', output_name)

    if os.path.isfile(final_video):
        os.remove(final_video)

    # ── Clean chat frames ──────────────────────────────────────────────────────
    chat_dir = '../chat'
    if os.path.exists(chat_dir):
        for file in os.listdir(chat_dir):
            os.remove(os.path.join(chat_dir, file))
        os.rmdir(chat_dir)

    # ── Generate chat images ───────────────────────────────────────────────────
    print(f"Reading script: {script_file}")
    with open(script_file, encoding='utf8') as f:
        lines = f.read().splitlines()

    current_time = datetime.datetime.now()
    print(f"Generating chat images{'  (long mode)' if args.long else ''}...")
    save_images(lines, init_time=current_time)

    # ── Compile video ──────────────────────────────────────────────────────────
    print("Compiling video with sound + sad outro...")
    gen_vid(script_file, output_path=f"../{output_name}")
    mode_label = 'final_long.mp4' if args.long else 'vertical_short.mp4'
    print(f"✓ Video generated → {mode_label}")

    # ── Generate thumbnail ─────────────────────────────────────────────────────
    if not args.no_thumbnail:
        try:
            from thumbnail_generator import generate_thumbnail, create_notabot_variants
            print("Generating thumbnail...")
            create_notabot_variants()
            generate_thumbnail()   # reads # TITLE: from the script automatically
        except Exception as e:
            print(f"⚠ Thumbnail generation failed (non-fatal): {e}")

    print("All done! 🎉")


if __name__ == '__main__':
    main()
