import os
import glob
from moviepy.editor import VideoFileClip, concatenate_videoclips

from video_chunker import chunk_video_and_create_sprites
from vision_analyzer import analyze_sprite_sheet
from asset_manager import prepare_assets_for_scene
from renderer import render_scene

def run_pipeline(input_video_path, output_video_path):
    print(f"Starting Gumbino-style pipeline for: {input_video_path}")
    
    workspace_dir = "workspace"
    sprites_dir = os.path.join(workspace_dir, "sprites")
    assets_dir = os.path.join(workspace_dir, "assets")
    chunks_dir = os.path.join(workspace_dir, "chunks")
    
    os.makedirs(sprites_dir, exist_ok=True)
    os.makedirs(assets_dir, exist_ok=True)
    os.makedirs(chunks_dir, exist_ok=True)
    
    chunk_duration = 5 # seconds
    
    # 1. Chunk video & create sprites
    print("STEP 1: Video Chunking & Sprite Extraction")
    sprite_paths = chunk_video_and_create_sprites(input_video_path, sprites_dir, chunk_duration=chunk_duration)
    
    if not sprite_paths:
        print("Failed to extract sprites.")
        return
        
    rendered_chunks = []
    
    for i, sprite_path in enumerate(sprite_paths):
        print(f"\n--- Processing Chunk {i} ---")
        
        # 2. Vision Analysis
        print("STEP 2: Vision Analysis")
        scene_json = analyze_sprite_sheet(sprite_path)
        print("Scene analysis:", scene_json)
        
        # 3. Asset Gathering
        print("STEP 3: Asset Gathering")
        prepared_assets = prepare_assets_for_scene(scene_json, assets_dir)
        
        # 4. Rendering
        print("STEP 4: Rendering Scene")
        output_chunk_path = os.path.join(chunks_dir, f"rendered_chunk_{i:04d}.mp4")
        
        try:
            render_scene(prepared_assets, scene_json, chunk_duration, output_chunk_path)
            rendered_chunks.append(output_chunk_path)
        except Exception as e:
            print(f"Error rendering chunk {i}: {e}")
            
    # 5. Final Stitching
    print("\nSTEP 5: Final Stitching")
    if not rendered_chunks:
        print("No chunks rendered successfully.")
        return
        
    try:
        clips = [VideoFileClip(c) for c in rendered_chunks]
        final_video = concatenate_videoclips(clips)
        final_video.write_videofile(
            output_video_path,
            fps=24,
            codec="libx264",
            audio_codec="aac"
        )
        print(f"PIPELINE COMPLETE. Final video saved to {output_video_path}")
    except Exception as e:
        print(f"Error during final stitching: {e}")

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 2:
        run_pipeline(sys.argv[1], sys.argv[2])
    else:
        print("Usage: python main.py <input_video.mp4> <output_video.mp4>")
