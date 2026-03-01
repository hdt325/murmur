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

# Save as iconset
iconset_dir = "Murmur.app/Contents/Resources/AppIcon.iconset"
os.makedirs(iconset_dir, exist_ok=True)

sizes = [16, 32, 64, 128, 256, 512, 1024]
for s in sizes:
    resized = img.resize((s, s), Image.LANCZOS)
    resized.save(f"{iconset_dir}/icon_{s}x{s}.png")
    if s <= 512:
        resized2x = img.resize((s * 2, s * 2), Image.LANCZOS)
        resized2x.save(f"{iconset_dir}/icon_{s}x{s}@2x.png")

# Convert to icns
subprocess.run(["iconutil", "-c", "icns", iconset_dir, "-o",
                "Murmur.app/Contents/Resources/AppIcon.icns"], check=True)

# Clean up iconset
shutil.rmtree(iconset_dir)

print("Icon created: Murmur.app/Contents/Resources/AppIcon.icns")
