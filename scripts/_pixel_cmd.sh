#!/bin/bash
# Android QA: type one chat command into Minecraft Bedrock on a connected device.
#   ANDROID_SERIAL=<serial> scripts/_pixel_cmd.sh "/summon craftmatic:timemachine_car ~ ~ ~5"
# Saga ignores plain input taps. A zero-distance swipe is the reliable equivalent.
set -euo pipefail
export MSYS_NO_PATHCONV=1
txt="${1:?usage: _pixel_cmd.sh \"/command\"}"
txt="${txt// /%s}"
serial_args=()
if [[ -n "${ANDROID_SERIAL:-}" ]]; then serial_args=(-s "$ANDROID_SERIAL"); fi
tap() { adb "${serial_args[@]}" shell input swipe "$1" "$2" "$1" "$2" 90; }
chat_x=1120
if [[ "${ANDROID_SERIAL:-}" == 192.168.1.243:* ]]; then chat_x=1195; fi
tap "$chat_x" 39;       sleep 1.2   # chat icon
tap 1100 954;            sleep 0.6   # text field
adb "${serial_args[@]}" shell input keycombination 113 29; sleep 0.2
adb "${serial_args[@]}" shell input keyevent 67;  sleep 0.2
adb "${serial_args[@]}" shell input text "$txt"; sleep 0.6
adb "${serial_args[@]}" shell input keyevent 66;  sleep 1.2
tap 45 39;               sleep 0.6   # Exit (chat sometimes stays open)
