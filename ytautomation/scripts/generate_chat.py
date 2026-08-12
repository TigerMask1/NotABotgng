from PIL import Image, ImageFont, ImageDraw
from pilmoji import Pilmoji
import sys
import datetime
import os
import json
import random
import regex
import re
import hashlib
import urllib.request
import urllib.parse

from PyQt5.QtWidgets import QApplication
from PyQt5.QtWidgets import QFileDialog

# CONSTANTS
WORLD_WIDTH = 1777
WORLD_Y_INIT_MESSAGE = 231
WORLD_DY = 70
WORLD_HEIGHTS_MESSAGE = [WORLD_Y_INIT_MESSAGE + i * WORLD_DY for i in range(100)]
WORLD_COLOR = (54, 57, 63, 255)

WORLD_HEIGHT_JOINED = 100
JOINED_FONT_SIZE = 45
JOINED_FONT_COLOR = (157, 161, 164)
JOINED_TEXTS = [
    "CHARACTER joined the party.",
    "CHARACTER is here.",
    "Welcome, CHARACTER. We hope you brought pizza.",
    "A wild CHARACTER appeared.",
    "CHARACTER just landed.",
    "CHARACTER just slid into the server.",
    "CHARACTER just showed up.",
    "Welcome CHARACTER. Say hi!",
    "CHARACTER hopped into the server.",
    "Everyone welcome CHARACTER!",
    "Glad you're here, CHARACTER!",
    "Good to see you, CHARACTER!",
    "Yay you made it, CHARACTER!",
]

PROFPIC_WIDTH = 120
PROFPIC_POSITION = (36, 45)

NAME_FONT_SIZE = 50
TIME_FONT_SIZE = 40
MESSAGE_FONT_SIZE = 50
NAME_FONT_COLOR = (255, 255, 255)
TIME_FONT_COLOR = (148, 155, 164)
MESSAGE_FONT_COLOR = (220, 222, 225)
NAME_POSITION = (190, 53)
TIME_POSITION_Y = 67  # X to be determined from name length
NAME_TIME_SPACING = 25
MESSAGE_X = 190
MESSAGE_Y_INIT = 115
MESSAGE_DY = 70
MESSAGE_POSITIONS = [(MESSAGE_X, MESSAGE_Y_INIT + i * MESSAGE_DY) for i in range(100)]

ASSET_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'assets'))
FONT_ROOT = os.path.join(ASSET_ROOT, 'fonts', 'whitney')

# Load fonts
font = "whitney" # Change this according to the font you want to use
name_font = ImageFont.truetype(os.path.join(FONT_ROOT, 'semibold.ttf'), NAME_FONT_SIZE)
time_font = ImageFont.truetype(os.path.join(FONT_ROOT, 'semibold.ttf'), TIME_FONT_SIZE)
message_font = ImageFont.truetype(os.path.join(FONT_ROOT, 'medium.ttf'), MESSAGE_FONT_SIZE)
message_italic_font = ImageFont.truetype(os.path.join(FONT_ROOT, 'medium_italic.ttf'), MESSAGE_FONT_SIZE)
message_bold_font = ImageFont.truetype(os.path.join(FONT_ROOT, 'bold.ttf'), MESSAGE_FONT_SIZE)
message_italic_bold_font = ImageFont.truetype(os.path.join(FONT_ROOT, 'bold_italic.ttf'), MESSAGE_FONT_SIZE)
message_mention_font = ImageFont.truetype(os.path.join(FONT_ROOT, 'semibold.ttf'), MESSAGE_FONT_SIZE)
message_mention_italic_font = ImageFont.truetype(os.path.join(FONT_ROOT, 'semibold_italic.ttf'), MESSAGE_FONT_SIZE)

# Load profile picture dictionary
characters_path = os.path.join(ASSET_ROOT, 'profile_pictures', 'characters.json')
with open(characters_path, encoding="utf8") as file:
    characters_dict = json.load(file)

PROFILE_PIC_DIR = os.path.join(ASSET_ROOT, 'profile_pictures', 'remote')
os.makedirs(PROFILE_PIC_DIR, exist_ok=True)


def download_remote_file(url, destination_dir, default_name='file'):
    if not url:
        return None
    parsed = urllib.parse.urlparse(url)
    if not parsed.scheme:
        return None
    safe_name = hashlib.sha1(url.encode('utf-8')).hexdigest()[:16]
    ext = os.path.splitext(parsed.path)[1] or '.png'
    if not ext.startswith('.'):
        ext = '.png'
    dest_path = os.path.join(destination_dir, f"{safe_name}{ext}")
    if os.path.exists(dest_path):
        return dest_path
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=10) as response:
            data = response.read()
        with open(dest_path, 'wb') as fh:
            fh.write(data)
        return dest_path
    except Exception:
        return None


def ensure_character_avatar(name, avatar_url):
    if not avatar_url:
        return None
    profile_name = re.sub(r'[^a-zA-Z0-9._-]+', '_', name).strip('_') or 'character'
    cached_path = os.path.join(PROFILE_PIC_DIR, f"{profile_name}.png")
    if os.path.exists(cached_path):
        return cached_path
    downloaded = download_remote_file(avatar_url, PROFILE_PIC_DIR, default_name=f"{profile_name}.png")
    if downloaded:
        try:
            img = Image.open(downloaded)
            img = img.convert('RGBA')
            img.save(cached_path)
            return cached_path
        except Exception:
            return downloaded
    return None


def is_emoji_message(message):
    """Return True if the message contains only emoji characters."""
    return bool(message) and all(regex.match(r'^\p{Emoji}+$', char) for char in message.strip())


def generate_chat(messages, name_time, profpic_file, color):
    """
    Generates a chat image given the list of messages, name & time info,
    profile picture file, and a role color.
    """
    name_text = name_time[0]
    time_text = f'Today at {name_time[1]} PM'
    
    # Calculate baseline-aligned time position
    name_ascent, _ = name_font.getmetrics()
    time_ascent, _ = time_font.getmetrics()
    baseline_y = NAME_POSITION[1] + name_ascent
    time_position = (
        NAME_POSITION[0] + name_font.getbbox(name_text)[2] + NAME_TIME_SPACING,
        baseline_y - time_ascent
    )
    
    # Open and process profile picture
    prof_pic = Image.open(profpic_file)
    prof_pic.thumbnail((sys.maxsize, PROFPIC_WIDTH), Image.Resampling.LANCZOS)
    mask = Image.new("L", prof_pic.size, 0)
    ImageDraw.Draw(mask).ellipse([(0, 0), (PROFPIC_WIDTH, PROFPIC_WIDTH)], fill=255)
    
    # Adjust vertical size for emoji-only messages
    y_increment = 0
    for msg in messages:
        if is_emoji_message(msg):
            bbox = message_font.getbbox("💀")
            y_increment += (bbox[3] - bbox[1]) + 8

    total_height = WORLD_HEIGHTS_MESSAGE[len(messages) - 1] + y_increment
    template = Image.new(mode='RGBA', size=(WORLD_WIDTH, total_height), color=WORLD_COLOR)
    template.paste(prof_pic, PROFPIC_POSITION, mask)
    draw_template = ImageDraw.Draw(template)
    
    draw_template.text(NAME_POSITION, name_text, color, font=name_font)
    
    # Track the rightmost x-coordinate any content reaches, so we know the
    # real content width without having to guess from pixels later.
    max_x_reached = NAME_POSITION[0] + name_font.getbbox(name_text)[2]
    
    # If it's NOTABOT, draw the APP badge
    if name_text == "NOTABOT":
        name_width = name_font.getbbox(name_text)[2]
        badge_x = NAME_POSITION[0] + name_width + 15
        
        # Draw blue rounded rectangle for the APP badge
        badge_font = ImageFont.truetype(os.path.join(f'../assets/fonts/{font}', 'bold.ttf'), 35)
        badge_text = "APP"
        badge_bbox = badge_font.getbbox(badge_text)
        badge_width = badge_bbox[2] - badge_bbox[0]
        badge_height = badge_bbox[3] - badge_bbox[1]
        
        padding_x, padding_y = 12, 6
        badge_box = [
            badge_x,
            NAME_POSITION[1] + 10,
            badge_x + badge_width + padding_x * 2,
            NAME_POSITION[1] + 10 + badge_height + padding_y * 2
        ]
        
        draw_template.rounded_rectangle(badge_box, fill=(88, 101, 242), radius=8) # Discord blurple
        draw_template.text((badge_x + padding_x, NAME_POSITION[1] + 8), badge_text, (255, 255, 255), font=badge_font)
        
        # Shift the time position further right
        time_position = (badge_box[2] + NAME_TIME_SPACING, time_position[1])
        max_x_reached = max(max_x_reached, badge_box[2])

    draw_template.text(time_position, time_text, TIME_FONT_COLOR, font=time_font)
    max_x_reached = max(max_x_reached, time_position[0] + time_font.getbbox(time_text)[2])

    y_offset = 0
    for i, message in enumerate(messages):
        message = message.strip()
        if not message:
            continue

        x, base_y = MESSAGE_POSITIONS[i]
        y_pos = base_y + y_offset
        current_x = x

        if is_emoji_message(message):
            with Pilmoji(template) as pilmoji:
                pilmoji.text((current_x, y_pos), message, MESSAGE_FONT_COLOR, font=message_font,
                             emoji_position_offset=(0, 8), emoji_scale_factor=2)
            emoji_bbox = message_font.getbbox(message)
            max_x_reached = max(max_x_reached, current_x + (emoji_bbox[2] - emoji_bbox[0]) * 2)
            y_offset += message_font.getbbox(message)[3]
            continue

        # Tokenize for bold (**), italic (__), and mentions (@...)
        tokens = re.split(r'(\*\*|__)', message)
        bold = italic = False
        with Pilmoji(template) as pilmoji:
            for token in tokens:
                if token == '**':
                    bold = not bold
                elif token == '__':
                    italic = not italic
                else:
                    if not token:
                        continue
                    # Split further by mentions
                    parts = re.split(r'(@\w+)', token)
                    for part in parts:
                        if not part:
                            continue
                        if part.startswith('@'):
                            # Choose font for mentions (mentions are always semibold)
                            if bold and italic:
                                font_used = message_mention_italic_font
                            elif bold:
                                font_used = message_mention_font
                            elif italic:
                                font_used = message_mention_italic_font
                            else:
                                font_used = message_mention_font

                            bbox = font_used.getbbox(part)
                            text_width = bbox[2] - bbox[0]
                            text_top = bbox[1]
                            text_bottom = bbox[3]
                            padding = 8
                            bg_box = [
                                current_x,
                                y_pos + text_top - padding,
                                current_x + text_width + 2 * padding,
                                y_pos + text_bottom + padding
                            ]
                            draw_template.rounded_rectangle(bg_box, fill=(74, 75, 114), radius=10)
                            pilmoji.text((current_x + padding, y_pos), part, (201, 205, 251), font=font_used)
                            current_x += text_width + 2 * padding
                            max_x_reached = max(max_x_reached, current_x)
                        else:
                            # Determine proper font for regular text
                            if bold and italic:
                                font_used = message_italic_bold_font
                            elif bold:
                                font_used = message_bold_font
                            elif italic:
                                font_used = message_italic_font
                            else:
                                font_used = message_font
                            pilmoji.text((current_x, y_pos), part, MESSAGE_FONT_COLOR, font=font_used,
                                         emoji_position_offset=(0, 8), emoji_scale_factor=1.2)
                            current_x += font_used.getbbox(part)[2] - font_used.getbbox(part)[0]
                            max_x_reached = max(max_x_reached, current_x)
    return template, max_x_reached


def generate_joined_message(name, time, template_str, arrow_x, color=NAME_FONT_COLOR):
    """
    Generates a Discord-like joined message with a green arrow.
    The character name will be colored with their role color.
    """
    before_text, after_text = template_str.split("CHARACTER", 1) if "CHARACTER" in template_str else ("", "")
    time_text = f'Today at {time} PM'
    
    template_img = Image.new(mode='RGBA', size=(WORLD_WIDTH, WORLD_HEIGHT_JOINED), color=WORLD_COLOR)
    draw_template = ImageDraw.Draw(template_img)
    
    arrow = Image.open("../assets/green_arrow.png")
    arrow.thumbnail((40, 40))
    text_x = arrow_x + arrow.width + 60

    text_bbox = message_font.getbbox("Sample")
    text_height = text_bbox[3] - text_bbox[1]
    text_y = (WORLD_HEIGHT_JOINED - text_height) // 2
    message_ascent, message_descent = message_font.getmetrics()
    total_text_height = message_ascent + message_descent
    arrow_y = text_y + (total_text_height - arrow.height) // 2

    template_img.paste(arrow, (arrow_x, arrow_y), arrow)
    
    before_width = message_font.getbbox(before_text)[2] if before_text else 0
    name_width = name_font.getbbox(name)[2]
    with Pilmoji(template_img) as pilmoji:
        if before_text:
            pilmoji.text((text_x, text_y), before_text, JOINED_FONT_COLOR, font=message_font)
        name_x = text_x + before_width
        pilmoji.text((name_x, text_y), name, color, font=name_font)
        if after_text:
            after_x = name_x + name_width
            pilmoji.text((after_x, text_y), after_text, JOINED_FONT_COLOR, font=message_font)
        
        total_msg_width = before_width + name_width + message_font.getbbox(after_text)[2]
        time_x = text_x + total_msg_width + 30
        time_baseline = text_y + message_ascent
        time_y = time_baseline - time_font.getmetrics()[0]
        pilmoji.text((time_x, time_y), time_text, TIME_FONT_COLOR, font=time_font)
    
    max_x_reached = time_x + time_font.getbbox(time_text)[2]
    return template_img, max_x_reached


def generate_joined_message_stack(joined_messages, hour):
    """
    Generates a stacked image for multiple joined messages.
    """
    total_height = WORLD_HEIGHT_JOINED * len(joined_messages)
    template_img = Image.new(mode='RGBA', size=(WORLD_WIDTH, total_height), color=WORLD_COLOR)
    
    max_x_reached = 0
    for idx, key in enumerate(joined_messages):
        name = key.split(' ')[1].split('$^')[0]
        color = characters_dict[name]["role_color"]
        time_str = f'{hour}:{joined_messages[key][2].minute:02d}'
        joined_img, right_edge = generate_joined_message(name, time_str, joined_messages[key][0], joined_messages[key][1], color)
        template_img.paste(joined_img, (0, idx * WORLD_HEIGHT_JOINED))
        max_x_reached = max(max_x_reached, right_edge)
    
    return template_img, max_x_reached


def generate_media_frame(title, subtitle, media_path=None):
    """Create a Discord-style media card frame that can be inserted into the video."""
    template = Image.new(mode='RGBA', size=(WORLD_WIDTH, 900), color=WORLD_COLOR)
    draw = ImageDraw.Draw(template)

    draw.rounded_rectangle((36, 36, WORLD_WIDTH - 36, 864), fill=(46, 49, 54), radius=28)
    draw.text((70, 70), title, fill=(255, 255, 255), font=name_font)
    draw.text((70, 145), subtitle, fill=(148, 155, 164), font=time_font)

    preview_box = (70, 220, WORLD_WIDTH - 70, 740)
    draw.rounded_rectangle(preview_box, fill=(71, 75, 86), radius=24)

    if media_path and os.path.exists(media_path):
        try:
            with Image.open(media_path) as img:
                img = img.convert('RGBA')
                img_w, img_h = img.size
                box_w = preview_box[2] - preview_box[0]
                box_h = preview_box[3] - preview_box[1]
                ratio = min(box_w / max(1, img_w), box_h / max(1, img_h))
                new_w = max(1, int(img_w * ratio))
                new_h = max(1, int(img_h * ratio))
                img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
                x = preview_box[0] + (box_w - new_w) // 2
                y = preview_box[1] + (box_h - new_h) // 2
                template.paste(img, (x, y), img)
        except Exception:
            draw.text((110, 350), 'media preview unavailable', fill=(220, 222, 225), font=message_font)
    else:
        draw.text((110, 350), 'discord media cue', fill=(220, 222, 225), font=message_font)

    return template, WORLD_WIDTH


def resolve_media_path(media_ref):
    if not media_ref:
        return None
    if os.path.exists(media_ref):
        return media_ref
    if isinstance(media_ref, str) and media_ref.startswith(('http://', 'https://')):
        return download_remote_file(media_ref, PROFILE_PIC_DIR, default_name='media')
    return None


def get_filename():
    app = QApplication(sys.argv)
    options = QFileDialog.Options()
    filename, _ = QFileDialog.getOpenFileName(
        None, "Select Text File", "", "Text Files (*.txt);;All Files (*)", options=options
    )
    app.exit()
    return filename


def save_images(lines, init_time, dt=30):
    os.makedirs('../chat', exist_ok=True)

    name_up_next = True
    current_time = init_time
    current_name = None
    current_lines = []
    msg_number = 1
    joined_messages = {}
    name_time = []

    # Maps "001" -> rightmost content x-coordinate, so compile_images.py can
    # crop each frame exactly instead of guessing from pixels afterward.
    content_widths = {}

    # Support queue-driven metadata in the same script format.
    queue_metadata = None
    if lines and lines[0].startswith('{'):
        try:
            queue_metadata = json.loads(lines[0])
            lines = lines[1:]
        except Exception:
            queue_metadata = None

    for line in lines:
        if line == '':
            name_up_next = True
            current_lines = []
            name_time = []
            joined_messages = {}
            continue

        if line.startswith('# PHOTO:') or line.startswith('# GIF:') or line.startswith('# MEDIA:'):
            content = line.split(':', 1)[1].strip()
            if line.startswith('# MEDIA:'):
                parts = content.split('|', 1)
                kind = parts[0].strip().lower() if parts else 'media'
                media_ref = parts[1].strip() if len(parts) > 1 else ''
                title = f'{kind} cue'
                subtitle = 'discord-native media frame'
            elif line.startswith('# PHOTO:'):
                kind = 'photo'
                media_ref = content
                title = 'photo cue'
                subtitle = content or 'discord screenshot'
            else:
                kind = 'gif'
                media_ref = content
                title = 'gif cue'
                subtitle = content or 'reaction gif'

            media_path = resolve_media_path(media_ref)
            image, right_edge = generate_media_frame(title, subtitle, media_path)
            image.save(f'../chat/{msg_number:03d}.png')
            content_widths[f'{msg_number:03d}'] = right_edge
            current_time += datetime.timedelta(seconds=dt)
            msg_number += 1
            joined_messages = {}
            continue

        if line.startswith('#'):
            joined_messages = {}
            continue

        if line.startswith("WELCOME "):
            joined_messages[line] = [random.choice(JOINED_TEXTS), random.randint(50, 80), current_time]
            hour = current_time.hour % 12 or 12
            image, right_edge = generate_joined_message_stack(joined_messages, hour)
            image.save(f'../chat/{msg_number:03d}.png')
            content_widths[f'{msg_number:03d}'] = right_edge
            current_time += datetime.timedelta(seconds=dt)
            msg_number += 1
            continue
        else:
            joined_messages = {}

        if name_up_next:
            current_name = line.split(':')[0]
            hour = current_time.hour % 12 or 12
            name_time = [current_name, f'{hour}:{current_time.minute:02d}']
            name_up_next = False
            continue

        current_lines.append(line.split('$^')[0])
        avatar_path = None
        if queue_metadata and current_name in queue_metadata.get('characters', {}):
            avatar_url = queue_metadata['characters'][current_name].get('avatar_url')
            avatar_path = ensure_character_avatar(current_name, avatar_url)
        if not avatar_path:
            fallback_char = characters_dict.get(current_name)
            if fallback_char and "profile_pic" in fallback_char:
                avatar_path = os.path.join('../assets/profile_pictures', fallback_char["profile_pic"])
            else:
                # Default generic avatar for unknown users
                avatar_path = os.path.join('../assets/profile_pictures', 'default.png')
                
        # Resolve role color (use metadata first, then characters_dict, then default)
        role_color = '#ffffff'
        if queue_metadata and current_name in queue_metadata.get('characters', {}):
            role_color = queue_metadata['characters'][current_name].get('role_color', '#ffffff')
        else:
            fallback_char = characters_dict.get(current_name)
            if fallback_char and "role_color" in fallback_char:
                role_color = fallback_char["role_color"]

        image, right_edge = generate_chat(
            messages=current_lines,
            name_time=name_time,
            profpic_file=avatar_path,
            color=role_color
        )
        image.save(f'../chat/{msg_number:03d}.png')
        content_widths[f'{msg_number:03d}'] = right_edge
        current_time += datetime.timedelta(seconds=dt)
        msg_number += 1

    with open('../chat/content_widths.json', 'w', encoding='utf8') as f:
        json.dump(content_widths, f, indent=2)


if __name__ == '__main__':
    """
    final_video = '../final_video.mp4'
    if os.path.isfile(final_video):
        os.remove(final_video)
    if os.path.exists('../chat'):
        for file in os.listdir('../chat'):
            os.remove(os.path.join('../chat', file))
        os.rmdir('../chat')

    filename = get_filename()
    with open(filename, encoding="utf8") as f:
        lines = f.read().splitlines()

    current_time = datetime.datetime.now()
    save_images(lines, init_time=current_time)

    # The following function is imported from compile_images.py
    from compile_images import gen_vid
    gen_vid(filename)
    """
    
    print('Please run the main.py script!')