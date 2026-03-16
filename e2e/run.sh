#!/usr/bin/env bash
set -e

# ─── E2E Test Runner for Pilot ───
#
# Runs the E2E test suite against a connected device/emulator.
#
# Prerequisites:
#   - Emulator running or physical device connected
#   - All components built: cargo build --release, npm run build, ./gradlew assembleDebug
#
# Usage:
#   ./e2e/run.sh                    # Run all E2E tests
#   ./e2e/run.sh device-management  # Run a specific test file

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

DAEMON_BIN="$ROOT_DIR/packages/pilot-core/target/release/pilot-core"
AGENT_APK="$ROOT_DIR/agent/app/build/outputs/apk/debug/app-debug.apk"
AGENT_TEST_APK="$ROOT_DIR/agent/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"

RED='\033[0;31m'
GREEN='\033[0;32m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

# ── Preflight checks ──

echo -e "${BOLD}Pilot E2E Tests${RESET}\n"

if ! adb devices | grep -q "device$"; then
  echo -e "${RED}No device/emulator connected. Start one first.${RESET}"
  exit 1
fi

if [ ! -f "$DAEMON_BIN" ]; then
  echo -e "${RED}Daemon not built. Run: cd packages/pilot-core && cargo build --release${RESET}"
  exit 1
fi

if [ ! -f "$AGENT_APK" ]; then
  echo -e "${RED}Agent APK not built. Run: cd agent && ./gradlew assembleDebug assembleDebugAndroidTest${RESET}"
  exit 1
fi

if [ ! -d "$ROOT_DIR/packages/pilot/dist" ]; then
  echo -e "${RED}SDK not built. Run: cd packages/pilot && npm run build${RESET}"
  exit 1
fi

# ── Start daemon if not running ──

if ! lsof -i :50051 -sTCP:LISTEN >/dev/null 2>&1; then
  echo -e "${DIM}Starting daemon...${RESET}"
  "$DAEMON_BIN" 2>/dev/null &
  DAEMON_PID=$!
  sleep 2
  echo -e "${DIM}Daemon started (PID $DAEMON_PID)${RESET}"
  trap "kill $DAEMON_PID 2>/dev/null" EXIT
else
  echo -e "${DIM}Daemon already running.${RESET}"
fi

# ── Determine test files ──

if [ -n "$1" ]; then
  TEST_FILES="$SCRIPT_DIR/$1.test.ts"
  if [ ! -f "$TEST_FILES" ]; then
    echo -e "${RED}Test file not found: $TEST_FILES${RESET}"
    exit 1
  fi
else
  TEST_FILES=$(find "$SCRIPT_DIR" -name '*.test.ts' | sort)
fi

echo -e "${DIM}Test files:${RESET}"
for f in $TEST_FILES; do
  echo -e "  ${DIM}$(basename "$f")${RESET}"
done
echo ""

# ── Run tests via the SDK's run-tests script ──

cd "$SCRIPT_DIR"
exec npx tsx "$SCRIPT_DIR/run-tests.mjs" $TEST_FILES
