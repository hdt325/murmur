#!/usr/bin/env python3
"""Generate Murmur app icon — cardiac murmur / heartbeat waveform design."""
from PIL import Image, ImageDraw
import math, os, subprocess, shutil

SIZE = 1024
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# Rounded rect background — deep dark blue
r = 180
bg = (16, 18, 36)  # near-black blue
draw.rounded_rectangle([40, 40, SIZE-40, SIZE-40], radius=r, fill=bg)

# Subtle inner border
draw.rounded_rectangle([60, 60, SIZE-60, SIZE-60], radius=r-10,
                       fill=None, outline=(40, 50, 80, 100), width=2)

cx, cy = SIZE // 2, SIZE // 2

# --- Draw cardiac murmur waveform (ECG/heartbeat trace) ---
# Classic heartbeat: flat → P wave → flat → QRS spike → flat → T wave → flat
# With a "murmur" (turbulent rumble) between S1 and S2

def ecg_point(t):
    """Return y-offset for time t (0..1) along the heartbeat trace."""
    # P wave (small bump)
    if 0.08 < t < 0.16:
        p = (t - 0.08) / 0.08
        return -40 * math.sin(p * math.pi)
    # Q dip
    if 0.22 < t < 0.26:
        p = (t - 0.22) / 0.04
        return 50 * math.sin(p * math.pi)
    # R spike (tall sharp peak)
    if 0.26 < t < 0.34:
        p = (t - 0.26) / 0.08
        return -320 * math.sin(p * math.pi)
    # S dip
    if 0.34 < t < 0.38:
        p = (t - 0.34) / 0.04
        return 80 * math.sin(p * math.pi)
    # Murmur zone (turbulent oscillation between S1 and S2)
    if 0.42 < t < 0.62:
        p = (t - 0.42) / 0.20
        # Diamond-shaped envelope (crescendo-decrescendo)
        envelope = 1.0 - abs(2 * p - 1)
        amplitude = 55 * envelope
        freq = 28  # rapid oscillation
        return amplitude * math.sin(freq * p * math.pi)
    # T wave (broad gentle bump)
    if 0.66 < t < 0.78:
        p = (t - 0.66) / 0.12
        return -70 * math.sin(p * math.pi)
    return 0

# Build the waveform path
trace_w = 780
trace_x0 = cx - trace_w // 2
steps = 600
points = []
for i in range(steps + 1):
    t = i / steps
    x = trace_x0 + int(t * trace_w)
    y = cy + int(ecg_point(t))
    points.append((x, y))

# Draw glow behind the trace (thicker, translucent)
for thickness, alpha in [(12, 30), (6, 60)]:
    glow_img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow_img)
    glow_draw.line(points, fill=(230, 60, 80, alpha), width=thickness, joint="curve")
    img = Image.alpha_composite(img, glow_img)

# Draw the main trace
draw = ImageDraw.Draw(img)
draw.line(points, fill=(230, 70, 85), width=4, joint="curve")

# Highlight the R-peak and murmur in brighter color
highlight_points_r = [(x, y) for (x, y) in points
                      if trace_x0 + int(0.24 * trace_w) <= x <= trace_x0 + int(0.40 * trace_w)]
if highlight_points_r:
    draw.line(highlight_points_r, fill=(255, 90, 100), width=5, joint="curve")

highlight_points_m = [(x, y) for (x, y) in points
                      if trace_x0 + int(0.42 * trace_w) <= x <= trace_x0 + int(0.62 * trace_w)]
if highlight_points_m:
    draw.line(highlight_points_m, fill=(255, 120, 130), width=4, joint="curve")

# Small heart icon below the waveform
hx, hy = cx, cy + 280
hs = 32  # half-size of heart
# Heart shape using two circles + triangle
draw.ellipse([hx - hs - 8, hy - hs, hx + 2, hy + 4], fill=(230, 60, 80))
draw.ellipse([hx - 2, hy - hs, hx + hs + 8, hy + 4], fill=(230, 60, 80))
draw.polygon([(hx - hs - 8, hy), (hx + hs + 8, hy), (hx, hy + hs + 16)], fill=(230, 60, 80))

# Flat baseline extensions (subtle) — left and right of waveform
baseline_color = (230, 70, 85, 80)
flat_img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
flat_draw = ImageDraw.Draw(flat_img)
flat_draw.line([(trace_x0 - 60, cy), (trace_x0, cy)], fill=baseline_color, width=3)
flat_draw.line([(trace_x0 + trace_w, cy), (trace_x0 + trace_w + 60, cy)], fill=baseline_color, width=3)
img = Image.alpha_composite(img, flat_img)

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
