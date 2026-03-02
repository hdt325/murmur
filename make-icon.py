#!/usr/bin/env python3
"""Generate Murmur app icon — crescendo-decrescendo murmur sound waveform."""
from PIL import Image, ImageDraw
import math, os, subprocess, shutil

SIZE = 1024
PAD = 40

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# Dark warm background
r = 180
bg = (28, 12, 18)
draw.rounded_rectangle([PAD, PAD, SIZE-PAD, SIZE-PAD], radius=r, fill=bg)
draw.rounded_rectangle([PAD+20, PAD+20, SIZE-PAD-20, SIZE-PAD-20], radius=r-10,
                       fill=None, outline=(60, 20, 30, 80), width=2)

cx, cy = SIZE // 2, SIZE // 2

# Cardiac murmur as a SOUND waveform — diamond-shaped envelope
# with turbulent, multi-harmonic oscillation (crescendo-decrescendo)
trace_w = 740
x0 = cx - trace_w // 2
steps = 600

def murmur_wave(t):
    # Diamond envelope: crescendo-decrescendo
    envelope = 1.0 - abs(2 * t - 1)
    envelope = envelope ** 0.8  # slightly sharper diamond

    # Multiple overlapping frequencies for turbulent character
    base = math.sin(t * 42 * math.pi)
    harm1 = 0.5 * math.sin(t * 67 * math.pi + 0.3)
    harm2 = 0.3 * math.sin(t * 91 * math.pi + 1.1)
    harm3 = 0.15 * math.sin(t * 130 * math.pi + 0.7)

    turbulence = base + harm1 + harm2 + harm3
    max_amplitude = 260
    return turbulence * envelope * max_amplitude / 1.95

points = []
for i in range(steps + 1):
    t = i / steps
    x = x0 + int(t * trace_w)
    y = cy + int(murmur_wave(t))
    points.append((x, y))

# Glow layers
color = (240, 75, 90)
glow = (240, 50, 70)

for w, a in [(18, 15), (10, 35), (6, 55)]:
    g = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(g).line(points, fill=(*glow, a), width=w, joint="curve")
    img = Image.alpha_composite(img, g)

draw = ImageDraw.Draw(img)
draw.line(points, fill=color, width=4, joint="curve")

# Brighter center (peak of diamond)
center_pts = [(x, y) for x, y in points
              if x0 + int(0.35 * trace_w) <= x <= x0 + int(0.65 * trace_w)]
if center_pts:
    draw.line(center_pts, fill=(255, 100, 110), width=4, joint="curve")

# Flat baseline extensions (subtle tails)
bl = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
bld = ImageDraw.Draw(bl)
bld.line([(x0 - 60, cy), (x0, cy)], fill=(*color[:3], 50), width=3)
bld.line([(x0 + trace_w, cy), (x0 + trace_w + 60, cy)], fill=(*color[:3], 50), width=3)
img = Image.alpha_composite(img, bl)

# Save as iconset (macOS .icns)
iconset_dir = "Murmur.app/Contents/Resources/AppIcon.iconset"
os.makedirs(iconset_dir, exist_ok=True)

sizes = [16, 32, 64, 128, 256, 512, 1024]
for s in sizes:
    resized = img.resize((s, s), Image.LANCZOS)
    resized.save(f"{iconset_dir}/icon_{s}x{s}.png")
    if s <= 512:
        resized2x = img.resize((s * 2, s * 2), Image.LANCZOS)
        resized2x.save(f"{iconset_dir}/icon_{s}x{s}@2x.png")

# Convert to icns (macOS only)
import platform
if platform.system() == "Darwin":
    subprocess.run(["iconutil", "-c", "icns", iconset_dir, "-o",
                    "Murmur.app/Contents/Resources/AppIcon.icns"], check=True)
    print("Icon created: Murmur.app/Contents/Resources/AppIcon.icns")

# Also save Electron icons
electron_icons = "electron/icons"
os.makedirs(electron_icons, exist_ok=True)

# Save a 16x16 PNG for macOS tray (template image)
img.resize((16, 16), Image.LANCZOS).save(f"{electron_icons}/icon_16x16.png")

# Save 256x256 PNG for Electron window icon
img.resize((256, 256), Image.LANCZOS).save(f"{electron_icons}/icon.png")

# Save .ico for Windows (multiple sizes embedded)
ico_sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
ico_images = [img.resize(s, Image.LANCZOS) for s in ico_sizes]
ico_images[0].save(f"{electron_icons}/icon.ico", format="ICO",
                   sizes=ico_sizes, append_images=ico_images[1:])
print(f"Electron icons created: {electron_icons}/icon.ico, icon.png, icon_16x16.png")

# Copy .icns for Electron macOS build
if platform.system() == "Darwin" and os.path.exists("Murmur.app/Contents/Resources/AppIcon.icns"):
    shutil.copy("Murmur.app/Contents/Resources/AppIcon.icns", f"{electron_icons}/icon.icns")
    print(f"Copied: {electron_icons}/icon.icns")

# Clean up iconset
shutil.rmtree(iconset_dir)
