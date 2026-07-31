import os
import requests
import urllib.parse
from bs4 import BeautifulSoup
import re

def download_sprite(query, output_dir, filename):
    """
    Searches for an image based on the query and downloads the first good hit.
    """
    os.makedirs(output_dir, exist_ok=True)
    filepath = os.path.join(output_dir, filename)
    
    # If it already exists, just return it
    if os.path.exists(filepath):
        print(f"Asset already exists: {filepath}")
        return filepath
        
    print(f"Searching web for: {query}")
    
    # Simple DuckDuckGo HTML search for images (this is brittle in production, 
    # but serves as a proof of concept for the pipeline)
    search_url = f"https://html.duckduckgo.com/html/?q={urllib.parse.quote(query + ' sprite png transparent')}"
    
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    }
    
    try:
        response = requests.get(search_url, headers=headers)
        response.raise_for_status()
        
        soup = BeautifulSoup(response.text, 'html.parser')
        # DDG HTML results might have images in thumbnail links
        images = soup.find_all('img', class_='result__icon__img')
        
        if not images:
            # Fallback to a placeholder if search fails
            print(f"Could not find image for {query}. Using fallback.")
            return create_fallback_image(filepath, query)
            
        img_url = images[0].get('src')
        if img_url.startswith('//'):
            img_url = 'https:' + img_url
            
        print(f"Downloading from {img_url}")
        img_data = requests.get(img_url, headers=headers).content
        with open(filepath, 'wb') as f:
            f.write(img_data)
            
        return filepath
        
    except Exception as e:
        print(f"Error scraping for {query}: {e}")
        return create_fallback_image(filepath, query)

def create_fallback_image(filepath, text):
    """Creates a basic image with text if scraping fails."""
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new('RGBA', (200, 200), color=(73, 109, 137, 255))
    d = ImageDraw.Draw(img)
    d.text((10, 90), text[:20], fill=(255, 255, 0, 255))
    img.save(filepath)
    return filepath

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 2:
        download_sprite(sys.argv[1], "assets", sys.argv[2])
    else:
        print("Usage: python asset_scraper.py <search_query> <output_filename>")
