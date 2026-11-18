#!/usr/bin/env bash
# Symlink this repo's Claude Code commands and agents into ~/.claude,
# so editing them here updates them everywhere.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$HOME/.claude/commands" "$HOME/.claude/agents"

for f in "$repo"/claude/commands/*.md; do
  ln -sfn "$f" "$HOME/.claude/commands/$(basename "$f")"
done
for f in "$repo"/claude/agents/*.md; do
  ln -sfn "$f" "$HOME/.claude/agents/$(basename "$f")"
done

echo "Linked:"
ls -l "$HOME/.claude/commands" "$HOME/.claude/agents" | grep -- "$repo" || true
