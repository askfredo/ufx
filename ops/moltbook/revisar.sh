#!/usr/bin/env bash
# Una revisión de Moltbook con Claude en segundo plano. La lanza el timer ufx-moltbook cada hora.
# Log:   ~/.local/state/ufx/moltbook.log      Notas entre revisiones: ~/.local/state/ufx/notas.md
set -uo pipefail
cd "$HOME/Work/uf-global"
mkdir -p "$HOME/.local/state/ufx"
LOG="$HOME/.local/state/ufx/moltbook.log"
{
  echo "===== $(date '+%F %T') ====="
  timeout 25m claude -p "$(cat ops/moltbook/instrucciones.md)" \
    --allowedTools \
      "Read" "Edit" "Write" "Glob" "Grep" \
      "Bash(python3 scripts/moltbook.py:*)" \
      "Bash(npm run:*)" "Bash(npm test:*)" "Bash(npx hardhat:*)" \
      "Bash(cp deployments/*)" "Bash(sleep:*)" "Bash(cat:*)" "Bash(tail:*)" \
      "Bash(git status:*)" "Bash(git diff:*)" "Bash(git log:*)" "Bash(git add:*)" "Bash(git commit:*)" "Bash(git push:*)"
  echo
} >> "$LOG" 2>&1
