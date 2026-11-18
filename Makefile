.PHONY: build test verify verify-memory app run demo install clean

build:
	swift build

test:
	swift test

# Everything that doesn't need a real screen: brain, panel and the Swift unit tests.
verify:
	cd brain && bun run typecheck && bun test tests
	cd web && bunx tsc --noEmit -p . && bun test tests && bun run build
	swift test --skip SkillReplayRealAppTests

# Memory end to end: the brain's index and recall with an in-memory engine. OKIDOKI_LIVE_MOSS=1 adds the real Moss engine.
verify-memory:
	cd brain && bun run typecheck && bun test tests/memory.test.ts tests/memory-sync.test.ts tests/memory-recall.test.ts
	cd web && bunx tsc --noEmit -p . && bun test tests/memorySearch.test.ts
	swift test --filter 'ContextTests|MemoryRecallTests'
	@if [ "$$OKIDOKI_LIVE_MOSS" = "1" ]; then cd brain && OKIDOKI_LIVE_MOSS=1 bun test tests/memory-live.test.ts; fi

app:
	./scripts/build-app.sh

# Always run the installed copy: macOS ties Accessibility, Screen Recording and Automation grants to the
# app's location, so launching build copies from several folders leaves stale grants that silently deny
# clicks and keys. One path in /Applications keeps a single valid grant across rebuilds.
run: install

demo: app
	OKIDOKI_DEMO=1 OKIDOKI_OPEN_DASHBOARD=1 "./build/Okidoki.app/Contents/MacOS/Okidoki"

# Installs as "/Applications/Okidoki.app" (bundle id dev.okidoki.mac). Only okidoki's own apps are
# quit or replaced; any other okidoki on this Mac is left alone. An older "Okidoki Personal" is
# moved aside (not deleted) and its data is adopted by copy on the new app's first launch.
install: app
	-osascript -e 'tell application id "dev.okidoki.mac" to quit' >/dev/null 2>&1
	-osascript -e 'tell application id "dev.okidoki.personal" to quit' >/dev/null 2>&1
	@for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do pgrep -xq Okidoki || pgrep -xq OkidokiPersonal || break; sleep 0.25; done
	@if [ -d "/Applications/Okidoki Personal.app" ]; then mv "/Applications/Okidoki Personal.app" "build/Okidoki Personal (0.9.1).app" 2>/dev/null || rm -rf "/Applications/Okidoki Personal.app"; fi
	rm -rf "/Applications/Okidoki.app"
	cp -R "build/Okidoki.app" /Applications/
	-launchctl bootout "gui/$(id -u)/dev.okidoki.personal.launch" 2>/dev/null || true
	-./scripts/install-cli.sh
	./scripts/launch-app.sh

clean:
	rm -rf .build build
