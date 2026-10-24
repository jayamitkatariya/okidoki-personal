# okidoki

A macOS assistant that lives in the notch and a control panel. Summon it by shaking
the pointer, ask for something, and approve what it wants to do before it does it.

## Layout

- `Sources/` — the native macOS app (Swift, SwiftUI and AppKit).
- `web/` — the control panel (React, Vite). Built into the app bundle.
- `brain/` — the TypeScript sidecar that routes requests (Bun).
- `backend/` — the optional Convex sync backend.

## Build

Requires macOS, Xcode command line tools, [Bun](https://bun.sh).

```bash
make app      # builds build/Okidoki.app (Swift, control panel, brain)
make run      # builds and opens it
make test     # Swift tests
```

Copy `backend/.env.local.example` to `backend/.env.local` only if you run the sync backend.
Keys are kept in the macOS Keychain, not in the repository.

## License

MIT. See [LICENSE](LICENSE).
