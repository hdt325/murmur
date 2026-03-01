#!/usr/bin/env python3
"""Generate Murmur app icon — dark waveform mic design."""
from PIL import Image, ImageDraw
import math, os, subprocess, shutil

SIZE = 1024
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# Rounded rect background
r = 180
bg = (22, 33, 62)  # #16213e
draw.rounded_rectangle([40, 40, SIZE-40, SIZE-40], radius=r, fill=bg)

# Subtle inner glow
draw.rounded_rectangle([60, 60, SIZE-60, SIZE-60], radius=r-10, fill=(26, 26, 46), outline=(15, 52, 96, 80), width=2)

cx, cy = SIZE // 2, SIZE // 2

# Audio waveform bars (stylized)
bar_w = 36
gap = 18
heights = [0.3, 0.5, 0.75, 1.0, 0.85, 0.65, 1.0, 0.75, 0.5, 0.3]
n = len(heights)
total_w = n * bar_w + (n - 1) * gap
start_x = cx - total_w // 2

for i, h in enumerate(heights):
    x = start_x + i * (bar_w + gap)
    bar_h = int(h * 320)
    y1 = cy - bar_h // 2
    y2 = cy + bar_h // 2

    # Gradient-ish: center bars are green, outer are blue
    t = abs(i - n/2 + 0.5) / (n/2)
    r_c = int(46 * t + 46 * (1-t))
    g_c = int(134 * t + 204 * (1-t))
    b_c = int(193 * t + 113 * (1-t))

    draw.rounded_rectangle([x, y1, x + bar_w, y2], radius=bar_w//2, fill=(r_c, g_c, b_c))

# Small mic icon at bottom
mic_cx, mic_cy = cx, cy + 260
mic_w, mic_h = 44, 70
draw.rounded_rectangle(
    [mic_cx - mic_w//2, mic_cy - mic_h//2, mic_cx + mic_w//2, mic_cy + mic_h//2],
    radius=mic_w//2, fill=(93, 173, 226)
)
# Mic stand
draw.line([mic_cx, mic_cy + mic_h//2, mic_cx, mic_cy + mic_h//2 + 30], fill=(93, 173, 226), width=6)
draw.line([mic_cx - 20, mic_cy + mic_h//2 + 30, mic_cx + 20, mic_cy + mic_h//2 + 30], fill=(93, 173, 226), width=6)
# Mic arc
for angle in range(0, 181, 2):
    rad = math.radians(angle)
    ax = mic_cx + int(36 * math.cos(rad))
    ay = mic_cy + int(36 * math.sin(rad)) - 10
    draw.ellipse([ax-2, ay-2, ax+2, ay+2], fill=(93, 173, 226, 120))

# Save as iconset
iconset_dir = "Murmur.app/Contents/Resources/AppIcon.iconset"
os.makedirs(iconset_dir, exist_ok=True)

sizes = [16, 32, 64, 128, 256, 512, 1024]
for s in sizes:
    resized = img.resize((s, s), Image.LANCZOS)
    resized.save(f"{iconset_dir}/icon_{s}x{s}.png")
    if s <= 512:
        resized2x = img.resize((s*2, s*2), Image.LANCZOS)
        resized2x.save(f"{iconset_dir}/icon_{s}x{s}@2x.png")

# Convert to icns
subprocess.run(["iconutil", "-c", "icns", iconset_dir, "-o",
                "Murmur.app/Contents/Resources/AppIcon.icns"], check=True)

# Clean up iconset
shutil.rmtree(iconset_dir)

print("Icon created: Murmur.app/Contents/Resources/AppIcon.icns")
