#!/usr/bin/env bash
# tests/run.sh — Run Murmur tests safely in the test-runner tmux session.
#
# CRITICAL: Tests must NOT be run directly in the claude-voice session (this Claude Code session).
# Murmur's passive watcher watches claude-voice and will pick up Claude Code's spinner + test output
# as Claude's response, breaking both the test run and the conversation.
#
# Usage (from project root):
#   tests/run.sh           → smoke tests
#   tests/run.sh all       → full suite: every test, service-aware (RECOMMENDED)
#   tests/run.sh e2e       → E2E + flow mode (~105 tests)
#   tests/run.sh flow      → comprehensive flow mode tests
#   tests/run.sh bugs      → regression tests
#   tests/run.sh smoke     → UI smoke tests
#   tests/run.sh qa        → visual QA tests
#
# Output is written to /tmp/murmur-test-results.txt and tailed here.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_FILE="/tmp/murmur-test-results.txt"
SESSION="test-runner"

# ── Build the command to send ──────────────────────────────────────────────

if [ "${1:-smoke}" = "all" ]; then
  # Detect optional voice services (Whisper + Kokoro)
  AUDIO_AVAILABLE=0
  curl -sf --max-time 2 http://localhost:2022/ > /dev/null 2>&1 && \
  curl -sf --max-time 2 http://localhost:8880/ > /dev/null 2>&1 && AUDIO_AVAILABLE=1

  # Write the orchestrator script to a temp file.
  # Uses single-quote heredoc so $vars are NOT expanded here — they run in test-runner.
  RUNNER=/tmp/murmur-run-all.sh
  cat > "$RUNNER" << 'RUNNER_SCRIPT'
#!/bin/bash
TOTAL_PASS=0
TOTAL_TOTAL=0
declare -a SUITE_RESULTS

run_suite() {
  local label="$1"; shift
  local out="/tmp/murmur-suite-${label// /-}.txt"
  echo ""
  echo "  ══════════════════════════════════════"
  echo "  $label"
  echo "  ══════════════════════════════════════"
  eval "$@" 2>&1 | tee "$out"
  local code=${PIPESTATUS[0]}
  # Parse "N/M passed" line written by each test suite
  local line
  line=$(grep -E "[0-9]+/[0-9]+ passed" "$out" | tail -1 || true)
  if [[ "$line" =~ ([0-9]+)/([0-9]+) ]]; then
    local p=${BASH_REMATCH[1]}
    local t=${BASH_REMATCH[2]}
    TOTAL_PASS=$((TOTAL_PASS + p))
    TOTAL_TOTAL=$((TOTAL_TOTAL + t))
    SUITE_RESULTS+=("$([ $code -eq 0 ] && echo '✓' || echo '✗')  $label: $p/$t passed")
  else
    SUITE_RESULTS+=("$([ $code -eq 0 ] && echo '✓' || echo '✗')  $label")
  fi
}
RUNNER_SCRIPT

  # Embed the project dir and always-on suites
  cat >> "$RUNNER" << SUITES
cd '$PROJECT_DIR'
run_suite "E2E + Flow Mode"  "node --import tsx/esm tests/test-e2e.ts"
run_suite "Flow Mode (deep)" "node --import tsx/esm tests/test-flow.ts"
run_suite "Regression"       "node --import tsx/esm tests/test-bugs.ts"
run_suite "Poll Detection"   "node --import tsx/esm tests/test-detection.ts"
SUITES

  # Conditionally add audio suites
  if [ "$AUDIO_AVAILABLE" -eq 1 ]; then
    cat >> "$RUNNER" << AUDIO_SUITES
run_suite "Audio Pipeline" "node --import tsx/esm tests/test-audio-pipeline.ts"
run_suite "TTS Pipeline"   "node --import tsx/esm tests/test-tts-pipeline.ts"
AUDIO_SUITES
  else
    cat >> "$RUNNER" << NO_AUDIO
echo ""
echo "  (Skipped: Audio Pipeline + TTS Pipeline — Whisper :2022 or Kokoro :8880 not reachable)"
NO_AUDIO
  fi

  # Summary footer
  cat >> "$RUNNER" << 'FOOTER'
echo ""
echo "  ══════════════════════════════════════"
echo "  ALL SUITES COMPLETE"
echo "  ══════════════════════════════════════"
echo "  Total: $TOTAL_PASS/$TOTAL_TOTAL tests passed"
echo ""
for r in "${SUITE_RESULTS[@]}"; do
  echo "    $r"
done
echo ""
FAIL_COUNT=$(printf '%s\n' "${SUITE_RESULTS[@]}" | grep -c '^✗' || true)
echo "EXIT:$([ "$FAIL_COUNT" -eq 0 ] && echo 0 || echo 1)"
FOOTER

  chmod +x "$RUNNER"
  TEST_CMD="bash $RUNNER"

else
  # Single suite
  case "${1:-smoke}" in
    e2e)         TEST_CMD="node --import tsx/esm tests/test-e2e.ts" ;;
    bugs)        TEST_CMD="node --import tsx/esm tests/test-bugs.ts" ;;
    flow)        TEST_CMD="node --import tsx/esm tests/test-flow.ts" ;;
    smoke)       TEST_CMD="node --import tsx/esm tests/test-smoke.ts" ;;
    detection)   TEST_CMD="node --import tsx/esm tests/test-detection.ts" ;;
    audio)       TEST_CMD="node --import tsx/esm tests/test-audio-pipeline.ts" ;;
    tts)         TEST_CMD="node --import tsx/esm tests/test-tts-pipeline.ts" ;;
    qa)          TEST_CMD="node --import tsx/esm test-qa-visual.ts" ;;
    qa:site)     TEST_CMD="node --import tsx/esm test-qa-visual.ts --site" ;;
    qa:electron) TEST_CMD="node --import tsx/esm test-qa-visual.ts --electron" ;;
    qa:all)      TEST_CMD="node --import tsx/esm test-qa-visual.ts --all" ;;
    *)
      echo "Unknown suite: $1"
      echo "Use: all, smoke, e2e, flow, bugs, detection, audio, tts, qa, qa:site, qa:electron, qa:all"
      exit 1
      ;;
  esac
fi

# ── Send to test-runner session ────────────────────────────────────────────

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Creating tmux session '$SESSION'..."
  tmux new-session -d -s "$SESSION"
fi

echo "Running in tmux session '$SESSION': ${1:-smoke}"
echo "Output: $OUTPUT_FILE"
echo ""

# Clear output file and run
> "$OUTPUT_FILE"
tmux send-keys -t "$SESSION" "cd '$PROJECT_DIR' && $TEST_CMD 2>&1 | tee '$OUTPUT_FILE'; echo EXIT:\$?" Enter

# Tail output until EXIT: marker appears
sleep 1
echo "--- Output (Ctrl+C to stop tailing — tests continue in $SESSION) ---"
tail -f "$OUTPUT_FILE" &
TAIL_PID=$!

while true; do
  sleep 1
  if grep -q "^EXIT:" "$OUTPUT_FILE" 2>/dev/null; then
    break
  fi
done

kill $TAIL_PID 2>/dev/null || true

EXIT_CODE=$(grep "^EXIT:" "$OUTPUT_FILE" | tail -1 | sed 's/EXIT://')
echo ""
echo "--- Done (exit code: ${EXIT_CODE:-?}) ---"
exit "${EXIT_CODE:-0}"
