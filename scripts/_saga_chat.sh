#!/bin/bash
# Type a Minecraft chat command on the Saga (Minecraft 26.52, Gboard). Measured quirks: bulk `input text`
# drops and reorders characters, and the FIRST character typed into the field lands at its END. So: clear,
# type a sacrificial "x" then the command one character at a time, drop the trailing "x", put "/" first.
# Usage: bash scripts/_saga_chat.sh "<command without leading slash>"   (the chat must already be open); then send Enter.
S=192.168.1.243:5555
adb -s $S shell "for i in \$(seq 1 60); do input keyevent 67; done; for i in \$(seq 1 30); do input keyevent 112; done"
sleep 1
cmd="x$1"
script=""
for ((i = 0; i < ${#cmd}; i++)); do
  c="${cmd:$i:1}"
  if [ "$c" = " " ]; then c="%s"; fi
  script="$script input text '$c'; sleep 0.15;"
done
MSYS_NO_PATHCONV=1 adb -s $S shell "$script"
MSYS_NO_PATHCONV=1 adb -s $S shell "input keyevent 123; sleep 0.3; input keyevent 67; sleep 0.3; input keyevent 122; sleep 0.3; input text '/'; sleep 0.3; input keyevent 123"
