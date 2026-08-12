import os
import math
import json

# Extra breathing room added past the detected/recorded content edge, so text
# and mention pills never look like they're touching the crop border.
EDGE_PADDING = 40

# Pillow 10+ removed Image.ANTIALIAS — patch it back so moviepy's resize works.
from PIL import Image as _PIL_Image
if not hasattr(_PIL_Image, 'ANTIALIAS'):
    _PIL_Image.ANTIALIAS = _PIL_Image.LANCZOS

from moviepy.editor import ImageClip, VideoFileClip, AudioFileClip, CompositeAudioClip, CompositeVideoClip, concatenate_videoclips, vfx


def get_content_right_edge(img_path, min_x2=850, max_x2=None, padding=EDGE_PADDING, bg_tolerance=12):
    """
    Detect how far right the actual content (chat bubbles, pfps, text) extends
    in a screenshot, instead of assuming a fixed 850px crop for every image.

    - If the image has an alpha channel, uses non-transparent pixels.
    - Otherwise, treats the top-left corner pixel as the background color and
      finds the rightmost pixel that differs from it by more than bg_tolerance.

    Returns an x2 value to use for cropping (never smaller than min_x2, so we
    never crop tighter than before — only wider when content demands it).
    """
    try:
        with _PIL_Image.open(img_path) as im:
            w, h = im.size
            if max_x2 is None:
                max_x2 = w

            if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
                im = im.convert("RGBA")
                alpha = im.split()[-1]
                bbox = alpha.getbbox()  # (left, upper, right, lower) of non-zero alpha
            else:
                im = im.convert("RGB")
                bg = im.getpixel((0, 0))
                # Build a mask of pixels that differ from background beyond tolerance
                import PIL.ImageChops as ImageChops
                bg_img = _PIL_Image.new("RGB", im.size, bg)
                diff = ImageChops.difference(im, bg_img)
                # Convert to grayscale "amount of difference" and threshold
                diff_gray = diff.convert("L")
                mask = diff_gray.point(lambda p: 255 if p > bg_tolerance else 0)
                bbox = mask.getbbox()

            if bbox is None:
                # Nothing detected (blank image) — fall back to previous fixed value
                return min(min_x2, w)

            right_edge = bbox[2] + padding
            right_edge = max(right_edge, min_x2)  # never crop tighter than before
            right_edge = min(right_edge, max_x2)  # never exceed actual image width
            return right_edge
    except Exception as e:
        print(f"  [CROP WARN] Could not auto-detect content width for {img_path}: {e}")
        return min_x2


def get_animation_func(anim_type, duration):
    if anim_type == "zoom_gradual":
        return lambda t: 1.0 + 0.05 * (t / duration) # Slow creep in
    elif anim_type == "zoom_sudden":
        # Snap zoom
        return lambda t: 1.0 if t < 0.05 else 1.15
    elif anim_type == "zoom_continuous":
        return lambda t: 1.0 + 0.1 * (t / duration)
    elif anim_type == "tilt":
        return lambda t: math.sin(t * 15) * 1.5 # Fast subtle shake
    return None

def gen_vid(filename, output_path="../vertical_short.mp4"):
    input_folder = '../chat/'
    
    # 1080x1920 is standard vertical shorts resolution
    VIDEO_W, VIDEO_H = 1080, 1920
    
    # generate_chat.py knows exactly where its own content ends (it drew it),
    # so it writes that out per-image. Prefer that over guessing from pixels.
    content_widths = {}
    widths_path = os.path.join(input_folder, 'content_widths.json')
    if os.path.exists(widths_path):
        try:
            with open(widths_path, encoding='utf8') as f:
                content_widths = json.load(f)
        except Exception as e:
            print(f'[compile] WARNING Could not read content_widths.json: {e}')
    
    clips = []
    audio_clips = []
    current_time = 0.0
    image_idx = 1
    
    with open(filename, encoding="utf8") as f:
        lines = f.read().splitlines()
        
    name_up_next = True
    for line in lines:
        line = line.strip()
        if not line:
            name_up_next = True
            continue
            
        if line.startswith("# TITLE:"):
            continue
            
        if line.startswith("# CLIP:"):
            # Strip quotes, backticks, and whitespace Gemini sometimes wraps around the name
            clip_name = line.split(":", 1)[1].strip().strip("'`\"").strip()
            clip_path = f"../assets/clips/{clip_name}.mp4"
            if os.path.exists(clip_path):
                vid_clip = VideoFileClip(clip_path)
                # Play fully (full time clip)
                vid_duration = vid_clip.duration
                vid_clip = vid_clip.subclip(0, vid_duration).set_start(current_time)
                # Resize to fit width
                vid_clip = vid_clip.resize(width=VIDEO_W).set_position('center')
                # Extract audio from clip so it isn't overwritten by the final composite audio
                if vid_clip.audio is not None:
                    audio_clips.append(vid_clip.audio.set_start(current_time))
                
                clips.append(vid_clip)
                current_time += vid_duration
            else:
                print(f"  [CLIP SKIP] '{clip_name}.mp4' not found — skipping this CLIP insert.")
            continue
            
        if line.startswith("#"):
            continue
            
        if line.startswith("WELCOME"):
            parts = line.split('$^')
            duration_part = parts[1].split('#!')[0]
            duration = float(duration_part)
            
            img_path = f"{input_folder}{image_idx:03d}.png"
            if os.path.exists(img_path):
                clip = ImageClip(img_path).set_start(current_time).set_duration(duration)
                
                # Crop tightly to the left side (where the chat and pfps are) to remove dead space.
                # Prefer the exact width recorded by generate_chat.py (it knows exactly where
                # it drew content); fall back to pixel-based auto-detection if unavailable.
                img_key = f"{image_idx:03d}"
                if img_key in content_widths:
                    crop_x2 = min(max(content_widths[img_key] + EDGE_PADDING, 850), clip.w)
                else:
                    crop_x2 = get_content_right_edge(img_path, min_x2=850, max_x2=clip.w)
                clip = clip.crop(x1=0, y1=0, x2=crop_x2, y2=clip.h)
                
                # Scale up to width 1080 (makes text huge and readable)
                clip = clip.resize(width=VIDEO_W)
                
                # Dynamic vertical positioning: keep newest text in view
                if clip.h < VIDEO_H - 400:
                    y_pos = 'center'
                else:
                    # Pin the bottom of the chat to the bottom of the screen (with 200px padding)
                    y_pos = VIDEO_H - 200 - clip.h 
                    
                clip = clip.set_position(('center', y_pos))
                
                clips.append(clip)
            image_idx += 1
            
            if "#!" in line:
                tags = line.split('#!')[1:]
                for tag in tags:
                    tag = tag.strip()
                    snd_path = f"../assets/sounds/mp3/{tag}.mp3"
                    if os.path.exists(snd_path):
                        audio_clips.append(AudioFileClip(snd_path).set_start(current_time))
            
            current_time += duration
            continue
            
        if name_up_next:
            name_up_next = False
            continue
            
        # Standard message line
        parts = line.split('$^')
        if len(parts) < 2:
            continue
            
        duration_part = parts[1].split('#!')[0]
        duration = float(duration_part)
        tags = line.split('#!')[1:] if '#!' in line else []
        
        img_path = f"{input_folder}{image_idx:03d}.png"
        if os.path.exists(img_path):
            clip = ImageClip(img_path).set_start(current_time).set_duration(duration)
            
            # Crop tightly to the left side to remove dead space.
            # Prefer the exact width recorded by generate_chat.py (it knows exactly where
            # it drew content); fall back to pixel-based auto-detection if unavailable.
            img_key = f"{image_idx:03d}"
            if img_key in content_widths:
                crop_x2 = min(max(content_widths[img_key] + EDGE_PADDING, 850), clip.w)
            else:
                crop_x2 = get_content_right_edge(img_path, min_x2=850, max_x2=clip.w)
            clip = clip.crop(x1=0, y1=0, x2=crop_x2, y2=clip.h)
            
            # Scale up to fill the 1080 width (makes text and pfps huge)
            clip = clip.resize(width=VIDEO_W)
            
            # Dynamic vertical positioning: keep newest text in view
            if clip.h < VIDEO_H - 400:
                y_pos = 'center'
            else:
                # Pin the bottom of the chat to the bottom of the screen
                y_pos = VIDEO_H - 200 - clip.h 
            
            # Animations
            anim_func = None
            anim_type = None
            for tag in tags:
                tag = tag.strip()
                if tag.startswith("zoom_") or tag == "tilt":
                    anim_type = tag
                    anim_func = get_animation_func(tag, duration)
                    
            if anim_func and anim_type and anim_type.startswith("zoom"):
                clip = clip.resize(anim_func)
                
            clip = clip.set_position(('center', y_pos))
            
            clips.append(clip)
        image_idx += 1
        
        # Audio
        default_snd = '../assets/sounds/mp3/message.mp3'
        if os.path.exists(default_snd):
            audio_clips.append(AudioFileClip(default_snd).set_start(current_time))
            
        for tag in tags:
            tag = tag.strip()
            if not tag.startswith("zoom_") and tag != "tilt" and tag != "message":
                snd_path = f"../assets/sounds/mp3/{tag}.mp3"
                if os.path.exists(snd_path):
                    audio_clips.append(AudioFileClip(snd_path).set_start(current_time))
        
        current_time += duration

    # Removed hardcoded comment bait overlays to keep the video clean and focused on the story.

    if not clips:
        print("Error: No valid clips generated.")
        return

    # Compile main content
    final_video = CompositeVideoClip(clips, size=(VIDEO_W, VIDEO_H))
    
    if audio_clips:
        final_audio = CompositeAudioClip(audio_clips)
        final_audio = final_audio.set_duration(current_time)
        final_video = final_video.set_audio(final_audio)

    # ── Append sad outro ──────────────────────────────────────────────────────
    outro_path = os.path.join(os.path.dirname(__file__), '..', 'assets', 'outros', 'sad_outro.mp4')
    if os.path.exists(outro_path):
        try:
            outro_clip = VideoFileClip(outro_path).resize((VIDEO_W, VIDEO_H))
            final_video = concatenate_videoclips([final_video, outro_clip], method='compose')
            print('[compile] OK Sad outro appended.')
        except Exception as e:
            print(f'[compile] WARNING Could not append outro: {e}')
    else:
        print(f'[compile] INFO No sad_outro.mp4 found - skipping. Run sad_outro_generator.py first.')

    # Output to specified path
    final_video.write_videofile(output_path, fps=24, codec="libx264", audio_codec="aac")

if __name__ == "__main__":
    gen_vid("../assets/example/generated_script.txt")