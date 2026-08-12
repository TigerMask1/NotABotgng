@echo off
echo Installing requirements...
pip install -r requirements.txt

echo.
echo Step 1: Generating Script with Gemini...
python scripts\generate_script.py
if errorlevel 1 goto error

echo.
echo Step 2: Generating Video with Text-2-Beluga...
cd scripts
python auto_main.py
if errorlevel 1 goto error
cd ..
if errorlevel 1 goto error

echo.
echo Step 3: Converting to Vertical (9:16)...
python scripts\make_vertical.py
if errorlevel 1 goto error

echo.
echo Success! The vertical video is saved as vertical_short.mp4
echo You can run 'python scripts\upload_youtube.py' to upload it manually.
goto end

:error
echo.
echo An error occurred during execution.
exit /b 1

:end
