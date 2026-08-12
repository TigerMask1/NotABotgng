import os
import math
import numpy as np

# Patch Pillow for moviepy
from PIL import Image as _PIL_Image
if not hasattr(_PIL_Image, 'ANTIALIAS'):
    _PIL_Image.ANTIALIAS = _PIL_Image.LANCZOS

from moviepy.editor import ImageClip, CompositeVideoClip, concatenate_videoclips, ColorClip

VIDEO_W, VIDEO_H = 1080, 1920

def create_demo_clip(img_path, anim_type, duration=3.0):
    clip = ImageClip(img_path).set_duration(duration)
    # Tightly crop
    clip = clip.crop(x1=0, y1=0, x2=min(850, clip.w), y2=clip.h)
    # Scale up
    clip = clip.resize(width=VIDEO_W)
    
    # Calculate base Y position (pin to bottom for realism)
    y_pos = VIDEO_H - 200 - clip.h if clip.h > VIDEO_H - 400 else 'center'
    
    if anim_type == "normal_elastic":
        # Slight pop in and settle (underdamped spring)
        def elastic_scale(t):
            # Scale goes from 0.8 to 1.0 with a slight bounce
            d = 5.0  # decay
            f = 10.0 # frequency
            return 1.0 - 0.2 * math.exp(-d * t) * math.cos(f * t)
        clip = clip.resize(elastic_scale)
        clip = clip.set_position(('center', y_pos))
        
    elif anim_type == "angry_shake":
        # Fast sine-wave jitter
        clip = clip.set_position(lambda t: (
            VIDEO_W/2 - clip.w/2 + math.sin(t * 30) * 10,
            (VIDEO_H/2 - clip.h/2 if y_pos == 'center' else y_pos) + math.cos(t * 25) * 10
        ))
        
    elif anim_type == "dramatic_snap":
        # Quick push-in and hold
        clip = clip.resize(lambda t: 1.0 if t < 0.1 else 1.15)
        clip = clip.set_position(('center', y_pos))
        
    elif anim_type == "suspense_creep":
        # Slow, continuous zooming
        clip = clip.resize(lambda t: 1.0 + 0.05 * (t / duration))
        clip = clip.set_position(('center', y_pos))
        
    elif anim_type == "impact_bounce":
        # Physical drop from above
        def drop_y(t):
            base_y = VIDEO_H/2 - clip.h/2 if y_pos == 'center' else y_pos
            # Gravity kinematics with bounce
            offset = abs(200 * math.exp(-4 * t) * math.cos(15 * t))
            return base_y - offset
        clip = clip.set_position(lambda t: ('center', drop_y(t)))
        
    # Remove the transition and just return the single clip
    return clip

def render():
    chat_dir = "../chat"
    imgs = sorted([f for f in os.listdir(chat_dir) if f.endswith('.png')])
    
    if len(imgs) < 5:
        print("Need at least 5 images in chat folder.")
        return
        
    animations = [
        ("normal_elastic", "Normal Message (Elastic Pop)"),
        ("angry_shake", "Angry/Yelling Message (Shake)"),
        ("dramatic_snap", "Dramatic Reveal (Snap Zoom)"),
        ("suspense_creep", "Suspense / Thinking (Slow Creep)"),
        ("impact_bounce", "Punchline / Vineboom (Impact Drop)")
    ]
    
    out_dir = "../assets/animations"
    os.makedirs(out_dir, exist_ok=True)
    
    print("Generating demo clips...")
    for i, (anim_type, desc) in enumerate(animations):
        print(f"Rendering: {anim_type}...")
        img_path = os.path.join(chat_dir, imgs[i+5])
        clip = create_demo_clip(img_path, anim_type, duration=3.0)
        
        out_path = os.path.join(out_dir, f"{anim_type}.mp4")
        clip.write_videofile(out_path, fps=30, codec="libx264", audio=False)
        print(f"Saved to {out_path}")
        
    print("All individual animations rendered successfully!")

if __name__ == "__main__":
    render()
