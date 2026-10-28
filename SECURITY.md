# Security

okidoki can see your screen and act on your Mac, so please report anything that could let someone
else do that. Open a private security advisory on GitHub, not a public issue.

## What protects you

- **Permissions** are yours to grant: Accessibility, Screen Recording and Automation, per app.
- **Approvals**: anything risky (deleting, sending, paying, installing, admin commands) is shown
  first and waits for **Do it**. You can mark apps "always ask" or block them entirely.
- **Keys** live in `keys.json` in the support folder (mode 0600). They're sent only to their own
  service, and never bundled into the app.
- **The brain** listens on 127.0.0.1 and needs a per-launch token.
- **The control endpoint** (`ControlServer`, used by the MCP server) listens on 127.0.0.1, needs the
  token in `control.json` (0600), and refuses any request with a browser `Origin`.
- **Vault logins** are sealed in the panel with your passphrase (PBKDF2, 200k rounds, then AES-GCM)
  before they reach the Mac. Only ciphertext is stored.
- **Passwords** are never typed by computer use. Admin prompts go straight to macOS through a
  native dialog and are never stored.
