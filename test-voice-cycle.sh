#!/bin/bash
# Test the full voice panel cycle: send text → poll → extract → TTS → client playback
# Run this while server is up and a client (phone) is connected

set -e
SERVER="http://localhost:3457"
TMUX_SESSION="claude-voice"

echo "=== Voice Panel Cycle Test ==="
echo ""

# 1. Check server is up
echo "1. Server status:"
curl -s "$SERVER/debug" | python3 -m json.tool
echo ""

# 2. Check tmux is alive
echo "2. Tmux session:"
if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    echo "   ✓ Session '$TMUX_SESSION' is alive"
else
    echo "   ✗ Session '$TMUX_SESSION' not found"
    exit 1
fi
echo ""

# 3. Capture current pane state
echo "3. Current pane tail (last 10 lines):"
tmux capture-pane -t "$TMUX_SESSION" -p -S -10 | tail -10 | sed 's/^/   /'
echo ""

# 4. Check if prompt is ready
echo "4. Prompt detection:"
PANE=$(tmux capture-pane -t "$TMUX_SESSION" -p -S -20)
if echo "$PANE" | grep -q '^❯[[:space:]]*$'; then
    echo "   ✓ Empty prompt found (ready for input)"
else
    echo "   ✗ No empty prompt — Claude may be busy"
    echo "   Last 5 non-empty lines:"
    echo "$PANE" | grep -v '^$' | tail -5 | sed 's/^/     /'
fi
echo ""

# 5. Send a test message and monitor
echo "5. Sending test message: 'hello, what is 2+2?'"
echo "   (This is a simple question that should get a short text response)"
echo ""

# Send via tmux
tmux send-keys -t "$TMUX_SESSION" -l "hello, what is 2+2?"
tmux send-keys -t "$TMUX_SESSION" C-m

echo "   Monitoring response (checking every 2s for up to 60s)..."
echo ""

START_TIME=$(date +%s)
LAST_PANE=""
STABLE_COUNT=0
FOUND_RESPONSE=false
SAW_SPINNER=false

for i in $(seq 1 30); do
    sleep 2
    ELAPSED=$(( $(date +%s) - START_TIME ))
    PANE=$(tmux capture-pane -t "$TMUX_SESSION" -p -S -30)
    TAIL=$(echo "$PANE" | tail -15)

    # Check for spinner
    if echo "$TAIL" | grep -qE '^[✻✳✢✽✶·⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]'; then
        SAW_SPINNER=true
        STABLE_COUNT=0
        echo "   [${ELAPSED}s] Spinner detected (Claude is working)"
    fi

    # Check for prompt
    HAS_PROMPT=false
    if echo "$TAIL" | grep -q '^❯[[:space:]]*$'; then
        HAS_PROMPT=true
    fi

    # Check if pane stopped changing
    if [ "$TAIL" = "$LAST_PANE" ] && [ "$HAS_PROMPT" = "true" ]; then
        STABLE_COUNT=$((STABLE_COUNT + 1))
    else
        STABLE_COUNT=0
    fi
    LAST_PANE="$TAIL"

    if [ "$HAS_PROMPT" = "true" ] && [ "$STABLE_COUNT" -ge 2 ]; then
        FOUND_RESPONSE=true
        echo "   [${ELAPSED}s] ✓ Prompt stable — response complete"
        break
    elif [ "$HAS_PROMPT" = "true" ]; then
        echo "   [${ELAPSED}s] Prompt visible (stable count: $STABLE_COUNT)"
    else
        echo "   [${ELAPSED}s] Waiting... (prompt=false spinner=$SAW_SPINNER)"
    fi
done

echo ""

if [ "$FOUND_RESPONSE" = "false" ]; then
    echo "   ✗ Response did not complete within 60s"
    echo "   Server state:"
    curl -s "$SERVER/debug" | python3 -m json.tool
    exit 1
fi

# 6. Extract what Claude said
echo "6. Extracting response from pane:"
FULL_PANE=$(tmux capture-pane -t "$TMUX_SESSION" -p -S -200)
# Find lines between the input and the next prompt
RESPONSE=$(echo "$FULL_PANE" | sed -n '/^❯ hello, what is 2+2/,/^❯[[:space:]]*$/p' | head -20)
echo "$RESPONSE" | sed 's/^/   /'
echo ""

# 7. Check server state
echo "7. Server state after response:"
curl -s "$SERVER/debug" | python3 -m json.tool
echo ""

# 8. Check if TTS was triggered (from server logs)
echo "8. Checking recent server logs for TTS activity:"
LOG_FILE=$(ls -t /private/tmp/claude-501/-Users-happythakkar-Desktop-Programming-voice-panel/tasks/*.output 2>/dev/null | head -1)
if [ -n "$LOG_FILE" ]; then
    grep -E 'Speaking|tts|client.*tts|Display|idle' "$LOG_FILE" | tail -10 | sed 's/^/   /'
fi
echo ""
echo "=== Test Complete ==="
