.PHONY: build test verify-terminal verify-memory app run demo install clean

build:
	swift build

test:
	swift test

verify-terminal:
	cd brain && bun run typecheck && bun test tests/terminal.test.ts tests/http.test.ts tests/connectors.test.ts
	cd web && bun test && bun run build
	swift test --filter 'TerminalActionsTests|ToolboxTests'

# Memory end to end: the brain's index and recall with an in-memory engine. OKIDOKI_LIVE_MOSS=1 adds the real Moss engine.
verify-memory:
	cd brain && bun run typecheck && bun test tests/memory.test.ts tests/memory-sync.test.ts
	cd web && bunx tsc --noEmit -p .
	swift test --filter 'ContextTests'
	@if [ "$$OKIDOKI_LIVE_MOSS" = "1" ]; then cd brain && OKIDOKI_LIVE_MOSS=1 bun test tests/memory-live.test.ts; fi

app:
	./scripts/build-app.sh

# Always run the installed copy: macOS ties Accessibility, Screen Recording and Automation grants to the
# app's location, so launching build copies from several folders leaves stale grants that silently deny
# clicks and keys. One path in /Applications keeps a single valid grant across rebuilds.
run: install

demo: app
	OKIDOKI_DEMO=1 OKIDOKI_OPEN_DASHBOARD=1 "./build/Okidoki Personal.app/Contents/MacOS/OkidokiPersonal"

# Installs as "/Applications/Okidoki Personal.app" (bundle id dev.okidoki.personal). Only that app is
# quit or replaced; any other okidoki on this Mac is left alone.
install: app
	-osascript -e 'tell application id "dev.okidoki.personal" to quit' >/dev/null 2>&1
	@for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do pgrep -xq OkidokiPersonal || break; sleep 0.25; done
	rm -rf "/Applications/Okidoki Personal.app"
	cp -R "build/Okidoki Personal.app" /Applications/
	./scripts/launch-app.sh

clean:
	rm -rf .build build
