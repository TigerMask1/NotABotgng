# Implementation Plan: "Production House" Expansion

## Goal Description
Transform the current Text-2-Beluga script into a **multi-format video production engine**. We will add two completely new, highly-polished video formats:
1. **ChatGPT UI Replica**: A format where a user prompts ChatGPT with funny/stupid questions and it responds in character, exactly mimicking the real ChatGPT interface (typing animations, logos, layout).
2. **Pokemon/RPG Sprite Style**: A visual novel/RPG style where characters appear as pixel-art sprites on background locations (like a Pokemon game), complete with text boxes, custom catchphrases, and animated speaking states.

## User Review Required

> [!IMPORTANT]
> **Production Quality & Asset Requirements**
> To make this look like a HIGH QUALITY production house (and not crap), we need specific assets. 
> - **For ChatGPT**: We will need to build an HTML/CSS renderer (using `Playwright` or `Selenium` to take screenshots of a web view) OR draw the UI perfectly using `Pillow` (PIL). HTML/CSS is strongly recommended for perfect UI replication (font rendering, spacing, typing cursors).
> - **For Pokemon**: We need background images (e.g., `pallet_town.png`, `gym.png`), character sprites (e.g., `ducky_idle.png`, `ducky_talking.png`), and a retro text-box overlay. 

## Open Questions

> [!WARNING]
> 1. **ChatGPT Engine**: Do you prefer we build the ChatGPT UI using HTML/CSS (we take automated screenshots of it, ensuring 100% pixel-perfect realism) or draw it purely in Python (which is faster but might look slightly less authentic)?
> 2. **Pokemon Assets**: Do you have a source for the game backgrounds and character sprites, or should we hook up an AI image generator / public sprite API to fetch them automatically?

## Proposed Changes

### 1. Core Engine Restructuring

#### [MODIFY] [scripts/main.py](file:///c:/Users/LENOVO/Documents/disc/Text-2-Beluga/scripts/main.py)
- Refactor the CLI to allow the user to select the **Video Format**:
  1. Classic Discord Chat
  2. ChatGPT Interface
  3. Pokemon RPG Style

#### [MODIFY] [scripts/generate_script.py](file:///c:/Users/LENOVO/Documents/disc/Text-2-Beluga/scripts/generate_script.py)
- Introduce a "Format" parameter to the prompt.
- **ChatGPT Prompt**: Instructs Gemini to write a user prompt and a savage/funny ChatGPT response.
- **Pokemon Prompt**: Instructs Gemini to write RPG dialogue with location tags and catchphrases.

---

### 2. ChatGPT UI Engine

#### [NEW] [scripts/renderers/chatgpt_renderer.py](file:///c:/Users/LENOVO/Documents/disc/Text-2-Beluga/scripts/renderers/chatgpt_renderer.py)
- A new renderer that mimics the OpenAI UI.
- It will parse the generated script (User vs ChatGPT).
- It will generate frames showing the user's prompt, followed by the ChatGPT logo "thinking", and then a **typing animation** (revealing the text word-by-word) for maximum engagement.

---

### 3. Pokemon / RPG Engine

#### [NEW] [scripts/renderers/rpg_renderer.py](file:///c:/Users/LENOVO/Documents/disc/Text-2-Beluga/scripts/renderers/rpg_renderer.py)
- **Backgrounds**: Loads a location background (e.g., `assets/rpg/backgrounds/lab.png`).
- **Sprites**: Places character sprites on the left or right side of the screen.
- **Text Box**: Draws a classic Pokemon-style dialog box at the bottom of the screen.
- **Animation**: Adds a slight "bounce" to the sprite that is currently talking, and plays a retro "blip" sound effect for every letter rendered in the dialog box to mimic old GameBoy games.

## Verification Plan

### Automated Tests
- We will test the routing logic in `auto_main.py` to ensure scripts are passed to the correct renderer based on the chosen format.

### Manual Verification
- Generate one ChatGPT video and one Pokemon video.
- Visually inspect the ChatGPT video to ensure the font (Söhne/Inter), colors, and layout perfectly match the real website.
- Visually inspect the Pokemon video to ensure the sprites align correctly with the dialog box and the "typing" sound effects sync with the text.
