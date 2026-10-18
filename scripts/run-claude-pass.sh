#!/usr/bin/env bash
# Called by improve-next.sh to run a single claude pass.
# Usage: bash run-claude-pass.sh <prompt_file> <log_file>
# Reads prompt from file, runs claude non-interactively, appends output to log.

PROMPT_FILE="$1"
LOG_FILE="$2"
PROJ="C:/git/craftmatic"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "[run-claude-pass] ERROR: prompt file not found: $PROMPT_FILE" >> "$LOG_FILE"
  exit 1
fi

PROMPT=$(cat "$PROMPT_FILE")
rm -f "$PROMPT_FILE"

cd "$PROJ"
unset CLAUDECODE
claude --dangerously-skip-permissions -p "$PROMPT" >> "$LOG_FILE" 2>&1
