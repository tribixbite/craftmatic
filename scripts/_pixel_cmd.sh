#!/bin/bash
# Android QA: type one chat command into Minecraft Bedrock on a connected device.
#   ANDROID_SERIAL=<serial> scripts/_pixel_cmd.sh "/summon craftmatic:timemachine_car ~ ~ ~5"
#   ANDROID_SERIAL=<serial> scripts/_pixel_cmd.sh --field-only "/say ready"
# Saga ignores plain input taps and corrupts bulk `input text`, so it needs the
# measured one-character-at-a-time path below (_saga_chat.sh delegates here).
set -euo pipefail
export MSYS_NO_PATHCONV=1
field_only=false
if [[ "${1:-}" == '--field-only' ]]; then
  field_only=true
  shift
fi
command="${1:?usage: _pixel_cmd.sh [--field-only] \"/command\"}"
# adb itself reads ANDROID_SERIAL when no -s is given, so every call below
# targets that device without passing it again.
tap() { adb shell input swipe "$1" "$2" "$1" "$2" 90; }

# Quote one argument for the device's POSIX shell. adb joins arguments into a
# remote command line, so passing untrusted chat text as a host-side argv item
# is not sufficient to protect quotes and shell metacharacters.
remote_quote() {
  local value="${1//\'/\'\\\'\'}"
  printf "'%s'" "$value"
}

device_model="$(adb shell getprop ro.product.model | tr -d '\r')"
is_saga=false
chat_x=1120
if [[ "${device_model,,}" == *saga* ]]; then
  is_saga=true
  chat_x=1195
fi

if ! $field_only; then
  tap "$chat_x" 39;       sleep 1.2   # chat icon
  tap 1100 954                          # text field
  if $is_saga; then sleep 2; else sleep 0.6; fi
fi

if $is_saga; then
  # Bulk input drops/reorders characters on Saga. Clear the existing field,
  # insert the slash key event to establish the editor state, then
  # type the body one character at a time; `input text '/'` is ignored by the
  # current Gboard.
  body="${command#/}"
  # Saga's Gboard ignores injected Ctrl+A in an already-focused field. Move to
  # the end and clear up to 512 characters in one `input` process instead of
  # relying on the cursor position or a short fixed window.
  clear_keys=(123)
  for ((i = 0; i < 512; i++)); do clear_keys+=(67); done
  adb shell input keyevent "${clear_keys[@]}"
  # The key-event queue remains busy after clearing; starting sooner can
  # silently drop the first several characters ("function" became "on").
  sleep 5
  adb shell "input keyevent 76; sleep 0.5"
  remote_script=''
  text="$body"
  for ((i = 0; i < ${#text}; i++)); do
    char="${text:i:1}"
    [[ "$char" == ' ' ]] && char='%s'
    remote_script+="input text $(remote_quote "$char"); sleep 0.15; "
  done
  adb shell "$remote_script"
else
  txt="${command// /%s}"
  adb shell input keycombination 113 29; sleep 0.2
  adb shell input keyevent 67;  sleep 0.2
  adb shell "input text $(remote_quote "$txt")"; sleep 0.6
fi

if ! $field_only; then
  adb shell input keyevent 66;  sleep 1.2
  # Exit only while the chat is still open (its soft keyboard is up). Tapping
  # the Exit corner after the chat has closed lands on the WORLD: on the Pixel
  # in round 30k that stray tap closed 76417's Gate 1 on the tester, whose
  # step-out then dropped them 17 blocks.
  if adb shell dumpsys input_method | grep -q 'mInputShown=true'; then
    tap 45 39;             sleep 0.6   # Exit
  fi
fi
