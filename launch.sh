#!/bin/bash
# Murmur — Start server + native floating panel
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Install deps if needed
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install --silent
fi

APP_BIN="VoicePanel.app/Contents/MacOS/VoicePanel"

# Compile native panel if needed
if [ ! -f "$APP_BIN" ] || [ "panel.swift" -nt "$APP_BIN" ]; then
  echo "Compiling native panel..."
  swiftc -framework Cocoa -framework WebKit -o "$APP_BIN" panel.swift
fi

# Generate icon if missing
if [ ! -f "VoicePanel.app/Contents/Resources/AppIcon.icns" ]; then
  echo "Generating app icon..."
  python3 make-icon.py 2>/dev/null || echo "Icon generation skipped (install Pillow: pip3 install Pillow)"
fi

# Kill any existing instances
pkill -f "VoicePanel.app/Contents/MacOS/VoicePanel" 2>/dev/null || true
pkill -f "tsx.*voice-panel.*server.ts" 2>/dev/null || true
sleep 0.3

# Clean up on exit
cleanup() {
  kill $SERVER_PID 2>/dev/null || true
  pkill -f "VoicePanel.app/Contents/MacOS/VoicePanel" 2>/dev/null || true
  exit 0
}
trap cleanup SIGINT SIGTERM

# Start server
npx tsx server.ts &
SERVER_PID=$!
echo "Server started (PID $SERVER_PID) on port 3457"

# Wait for server to be ready
for i in $(seq 1 30); do
  if curl -s http://localhost:3457 > /dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

# Launch native panel
open "$DIR/VoicePanel.app"
echo "Murmur launched"
echo "Press Ctrl+C to stop"

# Wait for server process
wait $SERVER_PID
