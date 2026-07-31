import os
from moviepy.editor import (
    ImageClip, AudioFileClip, CompositeVideoClip, TextClip, concatenate_audioclips, CompositeAudioClip
)
from PIL import Image

def render_scene(assets, scene_json, chunk_duration, output_path):
    """
    Renders a video chunk using MoviePy, combining background, character sprites,
    and dialogue audio.
    """
    print(f"Rendering scene to {output_path}...")
    
    # 1. Background
    bg_path = assets.get("background")
    if bg_path and os.path.exists(bg_path):
        bg_clip = ImageClip(bg_path).set_duration(chunk_duration)
        # Resize to standard 720p or 1080p
        bg_clip = bg_clip.resize(height=720)
    else:
        # Fallback solid color
        from moviepy.editor import ColorClip
        bg_clip = ColorClip(size=(1280, 720), color=(0, 0, 0)).set_duration(chunk_duration)
        
    video_clips = [bg_clip.set_position("center")]
    
    # 2. Characters
    chars_data = scene_json.get("characters", [])
    # Evenly space characters horizontally
    num_chars = len(chars_data)
    
    for i, char in enumerate(chars_data):
        char_img_path = assets["characters"].get(char)
        if char_img_path and os.path.exists(char_img_path):
            # Make sure it has alpha channel (transparency)
            try:
                char_clip = ImageClip(char_img_path).set_duration(chunk_duration)
                # Resize sprite (e.g. 200px height)
                char_clip = char_clip.resize(height=300)
                
                # Position logic
                x_pos = (1280 / (num_chars + 1)) * (i + 1) - (char_clip.w / 2)
                y_pos = 720 - char_clip.h - 50 # 50px from bottom
                
                char_clip = char_clip.set_position((x_pos, y_pos))
                video_clips.append(char_clip)
            except Exception as e:
                print(f"Error loading sprite for {char}: {e}")
                
    # 3. Text/Dialogue overlays (simple subtitle approach)
    dialogue_texts = scene_json.get("dialogue", [])
    if dialogue_texts:
        # Show each line for a fraction of the chunk duration
        time_per_line = chunk_duration / len(dialogue_texts)
        
        for i, line in enumerate(dialogue_texts):
            text = f"{line.get('character', '')}: {line.get('text', '')}"
            try:
                txt_clip = TextClip(text, fontsize=40, color='white', bg_color='black', stroke_color='black', stroke_width=2)
                txt_clip = txt_clip.set_position(('center', 50)).set_duration(time_per_line).set_start(i * time_per_line)
                video_clips.append(txt_clip)
            except Exception as e:
                # TextClip can fail if ImageMagick is not configured correctly on Windows
                print(f"Error creating text clip (ImageMagick missing?): {e}")

    # 4. Composite Video
    final_video = CompositeVideoClip(video_clips, size=(1280, 720)).set_duration(chunk_duration)
    
    # 5. Audio
    audio_clips = []
    current_audio_start = 0
    
    for audio_data in assets.get("audio", []):
        audio_file = audio_data.get("file")
        if audio_file and os.path.exists(audio_file):
            try:
                audio_clip = AudioFileClip(audio_file).set_start(current_audio_start)
                audio_clips.append(audio_clip)
                current_audio_start += audio_clip.duration + 0.5 # Add half a second gap
            except Exception as e:
                print(f"Error loading audio clip {audio_file}: {e}")
                
    if audio_clips:
        final_audio = CompositeAudioClip(audio_clips)
        # Trim audio to chunk duration if it's too long
        if final_audio.duration > chunk_duration:
            final_audio = final_audio.subclip(0, chunk_duration)
        final_video = final_video.set_audio(final_audio)

    # 6. Render
    final_video.write_videofile(
        output_path,
        fps=24,
        codec="libx264",
        audio_codec="aac",
        logger=None # Disable tqdm output to not spam logs
    )
    
    return output_path

if __name__ == "__main__":
    print("Run via main.py")
