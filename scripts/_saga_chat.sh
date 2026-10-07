#!/bin/bash
# Type a command into an already-open Saga chat field without submitting it.
# Usage: bash scripts/_saga_chat.sh "<command without leading slash>"; then send Enter.
set -euo pipefail
export ANDROID_SERIAL="${ANDROID_SERIAL:-192.168.1.243:5555}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
"$script_dir/_pixel_cmd.sh" --field-only "/${1:?usage: _saga_chat.sh \"command without leading slash\"}"
