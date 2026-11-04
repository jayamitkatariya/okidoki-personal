#!/bin/bash
# Puts the `okidoki` command on PATH: a two-line launcher that runs the CLI bundled in the installed app
# with bun (which okidoki's brain already needs). Other agents call it to hand okidoki tasks.
#
#   scripts/install-cli.sh               # ~/.local/bin/okidoki (or $OKIDOKI_BIN_DIR)
#   scripts/install-cli.sh --claude-skill  # and the okidoki skill for Claude Code (~/.claude/skills/okidoki)
#   claude mcp add okidoki -- okidoki mcp
set -euo pipefail
source "$(dirname "$0")/identity.sh"

APP="${OKIDOKI_INSTALLED_APP:-/Applications/$OKIDOKI_APP_NAME.app}"
CLI="$APP/Contents/Resources/cli/okidoki.js"
DIR="${OKIDOKI_BIN_DIR:-$HOME/.local/bin}"
[ -f "$CLI" ] || { echo "no CLI in $APP — build the app with bun installed" >&2; exit 1; }
BUN="$(command -v bun || true)"
[ -n "$BUN" ] || { echo "bun isn't installed (https://bun.sh); okidoki's brain needs it too" >&2; exit 1; }

mkdir -p "$DIR"
cat > "$DIR/okidoki" <<SH
#!/bin/sh
exec "$BUN" "$CLI" "\$@"
SH
chmod +x "$DIR/okidoki"
echo "▸ okidoki command at $DIR/okidoki"
case ":$PATH:" in *":$DIR:"*) ;; *) echo "  add $DIR to your PATH to call it as just \`okidoki\`" ;; esac

if [ "${1:-}" = "--claude-skill" ]; then
  mkdir -p "$HOME/.claude/skills/okidoki"
  cp "$(dirname "$0")/../mcp/skill/SKILL.md" "$HOME/.claude/skills/okidoki/SKILL.md"
  echo "▸ Claude Code skill at ~/.claude/skills/okidoki"
fi
