.PHONY: build test verify-terminal app run demo install clean backend

build:
	swift build

test:
	swift test

verify-terminal:
	cd brain && bun run typecheck && bun test tests/terminal.test.ts tests/http.test.ts tests/connectors.test.ts
	cd web && bun test && bun run build
	swift test --filter 'TerminalActionsTests|ToolboxTests'

app:
	./scripts/build-app.sh

run: app
	open build/Okidoki.app

demo: app
	OKIDOKI_DEMO=1 OKIDOKI_OPEN_DASHBOARD=1 ./build/Okidoki.app/Contents/MacOS/Okidoki

install: app
	-osascript -e 'tell application id "com.jaykatariya.okidoki" to quit' >/dev/null 2>&1
	@for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do pgrep -xq Okidoki || break; sleep 0.25; done
	rm -rf /Applications/Okidoki.app
	cp -R build/Okidoki.app /Applications/
	open /Applications/Okidoki.app

backend:
	cd backend && npm install && npx convex dev

clean:
	rm -rf .build build
