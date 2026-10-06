#!/bin/bash
# Android QA: type one chat command into Minecraft Bedrock on a connected device.
#   ANDROID_SERIAL=<serial> scripts/_pixel_cmd.sh "/summon craftmatic:timemachine_car ~ ~ ~5"
# Saga ignores plain input taps and corrupts bulk `input text`, so it needs the
# measured one-character-at-a-time path from _saga_chat.sh.
set -euo pipefail
export MSYS_NO_PATHCONV=1
command="${1:?usage: _pixel_cmd.sh \"/command\"}"
serial_args=()
if [[ -n "${ANDROID_SERIAL:-}" ]]; then serial_args=(-s "$ANDROID_SERIAL"); fi
tap() { adb "${serial_args[@]}" shell input swipe "$1" "$2" "$1" "$2" 90; }

# Quote one argument for the device's POSIX shell. adb joins arguments into a
# remote command line, so passing untrusted chat text as a host-side argv item
# is not sufficient to protect quotes and shell metacharacters.
remote_quote() {
  local value="${1//\'/\'\\\'\'}"
  printf "'%s'" "$value"
}

device_model="$(adb "${serial_args[@]}" shell getprop ro.product.model | tr -d '\r')"
is_saga=false
chat_x=1120
if [[ "${device_model,,}" == *saga* ]]; then
  is_saga=true
  chat_x=1195
fi

tap "$chat_x" 39;       sleep 1.2   # chat icon
tap 1100 954;            sleep 0.6   # text field

if $is_saga; then
  # Bulk input drops/reorders characters on Saga. Clear with both delete
  # directions, type the body one character at a time, then add the slash with
  # its key event; `input text '/'` is ignored by the current Gboard.
  body="${command#/}"
  adb "${serial_args[@]}" shell 'for i in $(seq 1 60); do input keyevent 67; done; for i in $(seq 1 30); do input keyevent 112; done'
  sleep 1
  remote_script=''
  text="$body"
  for ((i = 0; i < ${#text}; i++)); do
    char="${text:i:1}"
    [[ "$char" == ' ' ]] && char='%s'
    remote_script+="input text $(remote_quote "$char"); sleep 0.15; "
  done
  adb "${serial_args[@]}" shell "$remote_script"
  adb "${serial_args[@]}" shell "input keyevent 122; sleep 0.3; input keyevent 76; sleep 0.3; input keyevent 123"
else
  txt="${command// /%s}"
  adb "${serial_args[@]}" shell input keycombination 113 29; sleep 0.2
  adb "${serial_args[@]}" shell input keyevent 67;  sleep 0.2
  adb "${serial_args[@]}" shell "input text $(remote_quote "$txt")"; sleep 0.6
fi

adb "${serial_args[@]}" shell input keyevent 66;  sleep 1.2
tap 45 39;               sleep 0.6   # Exit (chat sometimes stays open)
