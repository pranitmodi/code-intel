#!/usr/bin/env bash
# Checkout → globally linked `code-intel` in one step.
set -euo pipefail
cd "$(dirname "$0")/.."
npm install
npm run build
npm link
echo "Linked. From any repo run:  code-intel onboard"
