#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
mkdir -p logs
node --import tsx scripts/lsp/mutation-soak.ts 2>&1 | tee logs/lsp-mutation-http-soak.log
