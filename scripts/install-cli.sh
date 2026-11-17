#!/bin/bash
# Puts the `okidoki` command on PATH (a two-line launcher that runs the CLI bundled in the installed app
# with bun, which okidoki's brain already needs) and installs the okidoki skill that teaches other agents
# (Claude Code, Codex, …) to use it. The app does the same from Settings › Use from other agents.
#
#   scripts/install-cli.sh             # ~/.local/bin/okidoki (or $OKIDOKI_BIN_DIR) + the skill
#   scripts/install-cli.sh --no-skill  # just the command
set -euo pipefail
source "$(dirname "$0")/identity.sh"

APP="${OKIDOKI_INSTALLED_APP:-/Applications/$OKIDOKI_APP_NAME.app}"
CLI="$APP/Contents/Resources/cli/okidoki.js"
DIR="${OKIDOKI_BIN_DIR:-$HOME/.local/bin}"
[ -f "$CLI" ] || { echo "no CLI in $APP — build the app with bun installed" >&2; exit 1; }
BUN="$(command -v bun || true)"
for candidate in "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
  [ -n "$BUN" ] || { [ -x "$candidate" ] && BUN="$candidate"; }
done
[ -n "$BUN" ] || { echo "bun isn't installed (https://bun.sh); okidoki's brain needs it too" >&2; exit 1; }

mkdir -p "$DIR"
cat > "$DIR/okidoki" <<SH
#!/bin/sh
exec "$BUN" "$CLI" "\$@"
SH
chmod +x "$DIR/okidoki"
echo "▸ okidoki command at $DIR/okidoki"
case ":$PATH:" in *":$DIR:"*) ;; *) echo "  add $DIR to your PATH to call it as just \`okidoki\`" ;; esac

if [ "${1:-}" != "--no-skill" ]; then
  SKILL="$APP/Contents/Resources/cli/SKILL.md"
  [ -f "$SKILL" ] || SKILL="$(dirname "$0")/../mcp/skill/SKILL.md"
  TARGETS=("$HOME/.claude/skills/okidoki" "$HOME/.agents/skills/okidoki")
  [ -d "$HOME/.codex" ] && TARGETS+=("$HOME/.codex/skills/okidoki")
  for target in "${TARGETS[@]}"; do
    mkdir -p "$target"
    cp "$SKILL" "$target/SKILL.md"
    echo "▸ okidoki skill at ${target/#$HOME/~}"
  done
fi
