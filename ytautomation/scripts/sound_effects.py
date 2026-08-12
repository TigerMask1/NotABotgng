import os
from moviepy.editor import VideoFileClip, AudioFileClip, CompositeAudioClip

def add_sounds(filename):
    # Load the video file
    video = VideoFileClip("output.mp4")
    duration = 0
    audio_clips = []

    with open(filename, encoding="utf8") as f:
        name_up_next = True
        for line in f.read().splitlines():
            if line == '':
                name_up_next = True
                continue
            elif line.startswith('#'):
                continue
            elif line.startswith("WELCOME"):
                if "#!" in line:
                    parts = line.split('$^')
                    duration_part, sound_part = parts[1].split("#!")
                    audio_file = f'../assets/sounds/mp3/{sound_part.strip()}.mp3'
                    audio_clip = AudioFileClip(audio_file).set_start(duration)
                    audio_clips.append(audio_clip)
                    duration += float(duration_part)
                else:
                    duration += float(line.split('$^')[1])
            elif name_up_next:
                name_up_next = False
                continue
            else:
                # Always add the default discord message ping for every message
                default_audio = '../assets/sounds/mp3/message.mp3'
                default_clip = AudioFileClip(default_audio).set_start(duration)
                audio_clips.append(default_clip)
                
                if "#!" in line:
                    parts = line.split('$^')
                    duration_part, sound_part = parts[1].split("#!")
                    sound_name = sound_part.strip()
                    
                    # If the sound is something else, overlay it on top!
                    if sound_name and sound_name != 'message':
                        audio_file = f'../assets/sounds/mp3/{sound_name}.mp3'
                        try:
                            audio_clip = AudioFileClip(audio_file).set_start(duration)
                            audio_clips.append(audio_clip)
                        except Exception:
                            pass # If hallucinated sound slips through, ignore gracefully
                    duration += float(duration_part)
                else:
                    duration += float(line.split('$^')[1])
                    
    if len(audio_clips) > 0:
        composite_audio = CompositeAudioClip(audio_clips)
        video = video.set_audio(composite_audio)
    else:
        pass

    video.write_videofile("../final_video.mp4", codec="libx264", audio_codec="aac")
    os.remove("output.mp4")