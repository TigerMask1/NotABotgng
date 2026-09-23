import os
from google import genai
from google.genai import types

api_key = os.environ.get("GEMINI_API_KEY")
client = genai.Client(api_key=api_key)

result = client.models.generate_images(
    model='imagen-3.0-generate-002',
    prompt='A dramatic lightning storm over a hacker desk',
    config=types.GenerateImagesConfig(
        number_of_images=1,
        output_mime_type="image/jpeg",
        aspect_ratio="16:9"
    )
)
for generated_image in result.generated_images:
    with open("test.jpg", "wb") as f:
        f.write(generated_image.image.image_bytes)
    print("Success! Image saved to test.jpg")
