#!/bin/bash
# Test poll detection by sending a text message via WebSocket and monitoring server logs
# This sends a simple question that Claude can answer without tool calls

set -e
SERVER="http://localhost:3457"
LOG_FILE="/private/tmp/claude-501/-Users-happythakkar-Desktop-Programming-voice-panel/tasks/b7sdlmfz9.output"

echo "=== Poll Detection Test ==="
echo ""

# 1. Check server is up
echo "1. Server status:"
curl -s "$SERVER/debug" | python3 -m json.tool
echo ""

# 2. Verify the server log file exists
if [ ! -f "$LOG_FILE" ]; then
    echo "Server log not found at $LOG_FILE"
    echo "Finding latest log..."
    LOG_FILE=$(ls -t /private/tmp/claude-501/-Users-happythakkar-Desktop-Programming-voice-panel/tasks/*.output 2>/dev/null | head -1)
    echo "Using: $LOG_FILE"
fi
echo ""

# 3. Get current log line count to only see new entries
LOG_LINES_BEFORE=$(wc -l < "$LOG_FILE" 2>/dev/null || echo "0")
echo "3. Log has $LOG_LINES_BEFORE lines before test"
echo ""

# 4. Send a simple text message via WebSocket using websocat (or node)
echo "4. Sending test message: 'Say hello and tell me what 2+2 equals in one sentence'"
echo "   (Using Node.js to send WebSocket message)"

node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3457');
ws.on('open', () => {
  ws.send('text:Say hello and tell me what 2+2 equals in one sentence');
  console.log('   Message sent via WebSocket');
  setTimeout(() => { ws.close(); process.exit(0); }, 1000);
});
ws.on('error', (e) => { console.error('WS error:', e.message); process.exit(1); });
" 2>&1

echo ""
echo "5. Monitoring server logs for poll activity (up to 120s)..."
echo ""

START_TIME=$(date +%s)
LAST_POLL_STATE=""
FOUND_DONE=false

for i in $(seq 1 60); do
    sleep 2
    ELAPSED=$(( $(date +%s) - START_TIME ))

    # Get new log lines since test started
    NEW_LINES=$(tail -n +$((LOG_LINES_BEFORE + 1)) "$LOG_FILE" 2>/dev/null)

    # Check for poll state transitions
    POLL_STATE=$(echo "$NEW_LINES" | grep -oE '\[poll\].*' | tail -1)
    POLL_DEBUG=$(echo "$NEW_LINES" | grep -oE '\[poll [0-9]+s\].*' | tail -1)
    DONE_LINE=$(echo "$NEW_LINES" | grep 'Poll done' | tail -1)
    DISPLAY_LINE=$(echo "$NEW_LINES" | grep 'Display output' | tail -1)
    SPEAK_LINE=$(echo "$NEW_LINES" | grep 'Speaking' | tail -1)

    # Show state changes
    if [ -n "$POLL_STATE" ] && [ "$POLL_STATE" != "$LAST_POLL_STATE" ]; then
        echo "   [${ELAPSED}s] $POLL_STATE"
        LAST_POLL_STATE="$POLL_STATE"
    fi
    if [ -n "$POLL_DEBUG" ]; then
        echo "   [${ELAPSED}s] $POLL_DEBUG"
    fi

    if [ -n "$DONE_LINE" ]; then
        FOUND_DONE=true
        echo ""
        echo "   ✓ $DONE_LINE"
        [ -n "$DISPLAY_LINE" ] && echo "   ✓ $DISPLAY_LINE"
        [ -n "$SPEAK_LINE" ] && echo "   ✓ $SPEAK_LINE"
        break
    fi
done

echo ""

if [ "$FOUND_DONE" = "false" ]; then
    echo "   ✗ Poll did not complete within 120s"
    echo ""
    echo "   Recent server log:"
    tail -20 "$LOG_FILE" | sed 's/^/   /'
fi

# 6. Check final server state
echo ""
echo "6. Final server state:"
curl -s "$SERVER/debug" | python3 -m json.tool

# 7. Show all poll-related log lines from this test
echo ""
echo "7. All poll log lines from this test:"
tail -n +$((LOG_LINES_BEFORE + 1)) "$LOG_FILE" | grep -E '\[poll|Poll done|Display|Speaking|voice_status|spinner|prompt' | sed 's/^/   /'

echo ""
echo "=== Test Complete ==="
