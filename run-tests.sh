#!/usr/bin/env bash
# Wrapper that invokes bun via mise. Use: ./run-tests.sh [args...]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
exec mise exec bun@1.3.13 -- bun test "$@"
