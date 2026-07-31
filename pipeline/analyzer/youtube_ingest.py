import os
import math
from moviepy.editor import VideoFileClip
from PIL import Image

def chunk_video_and_create_sprites(input_video_path, output_dir, chunk_duration=5, fps=2):
    """
    Splits a video into chunks and creates a sprite sheet (grid of frames) for each chunk.
    """
    os.makedirs(output_dir, exist_ok=True)
    
    try:
        clip = VideoFileClip(input_video_path)
    except Exception as e:
        print(f"Error loading video {input_video_path}: {e}")
        return []

    total_duration = clip.duration
    num_chunks = math.ceil(total_duration / chunk_duration)
    
    sprite_sheet_paths = []

    print(f"Total video duration: {total_duration:.2f}s. Splitting into {num_chunks} chunks.")

    for i in range(num_chunks):
        start_time = i * chunk_duration
        end_time = min((i + 1) * chunk_duration, total_duration)
        
        chunk_clip = clip.subclip(start_time, end_time)
        
        # Extract frames
        frames = []
        for frame in chunk_clip.iter_frames(fps=fps, dtype='uint8'):
            frames.append(Image.fromarray(frame))
            
        if not frames:
            continue
            
        # Determine grid size for sprite sheet
        num_frames = len(frames)
        cols = math.ceil(math.sqrt(num_frames))
        rows = math.ceil(num_frames / cols)
        
        frame_width, frame_height = frames[0].size
        
        # Create blank image for sprite sheet
        sheet_width = cols * frame_width
        sheet_height = rows * frame_height
        sprite_sheet = Image.new('RGB', (sheet_width, sheet_height))
        
        # Paste frames into sprite sheet
        for idx, frame in enumerate(frames):
            x = (idx % cols) * frame_width
            y = (idx // cols) * frame_height
            sprite_sheet.paste(frame, (x, y))
            
        # Save sprite sheet
        sheet_filename = f"chunk_{i:04d}_spritesheet.png"
        sheet_path = os.path.join(output_dir, sheet_filename)
        
        # Resize if too large for LLMs (optional but recommended, max 2048x2048 is safe)
        if max(sheet_width, sheet_height) > 2048:
            scale_factor = 2048 / max(sheet_width, sheet_height)
            new_size = (int(sheet_width * scale_factor), int(sheet_height * scale_factor))
            sprite_sheet = sprite_sheet.resize(new_size, Image.Resampling.LANCZOS)
            
        sprite_sheet.save(sheet_path)
        sprite_sheet_paths.append(sheet_path)
        print(f"Created sprite sheet for chunk {i}: {sheet_path}")
        
    clip.close()
    return sprite_sheet_paths

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 2:
        chunk_video_and_create_sprites(sys.argv[1], sys.argv[2])
    else:
        print("Usage: python video_chunker.py <input_video> <output_dir>")
