.PHONY: build test app run demo install clean backend

build:
	swift build

test:
	swift test

app:
	./scripts/build-app.sh

run: app
	open build/Okidoki.app

demo: app
	OKIDOKI_DEMO=1 OKIDOKI_OPEN_DASHBOARD=1 ./build/Okidoki.app/Contents/MacOS/Okidoki

install: app
	rm -rf /Applications/Okidoki.app
	cp -R build/Okidoki.app /Applications/
	open /Applications/Okidoki.app

backend:
	cd backend && npm install && npx convex dev

clean:
	rm -rf .build build
