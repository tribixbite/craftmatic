#!/bin/bash
# Wrapper to run craftmatic gen with an address that has spaces.
# grun splits quoted arguments, so we pass the address via env var.
# Usage: ADDRESS="123 Main St, City, ST 12345" bash scripts/gen-address.sh [extra flags]
exec grun ~/.bun/bin/buno src/cli.ts gen -a "$ADDRESS" "$@"
