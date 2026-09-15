#!/bin/bash
# Pixel QA: type one chat command into Minecraft Bedrock on the connected device.
#   scripts/_pixel_cmd.sh "/summon craftmatic:timemachine_car ~ ~ ~5"
# Sequence measured reliable on the Pixel 8 Pro (2244×1008 landscape, 1.26.45):
# tap the chat icon, tap the field, Ctrl+A, Del, type (spaces as %s), Enter,
# tap Exit. Coordinates are for that screen size — re-measure on another device.
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash rewrites "/tp …" into a Windows path otherwise
txt="${1:?usage: _pixel_cmd.sh \"/command\"}"
txt="${txt// /%s}"
adb shell input tap 1120 39;  sleep 1.2   # chat icon
adb shell input tap 1100 954; sleep 0.6   # text field
adb shell input keycombination 113 29; sleep 0.2   # Ctrl+A
adb shell input keyevent 67;  sleep 0.2   # Del
adb shell input text "$txt";  sleep 0.6
adb shell input keyevent 66;  sleep 1.2   # Enter
adb shell input tap 45 39;    sleep 0.6   # Exit (chat sometimes stays open)
