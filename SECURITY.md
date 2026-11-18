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
- **The control endpoint** (`ControlServer`, used by the `okidoki` CLI) listens on 127.0.0.1, needs the
  token in `control.json` (0600), and refuses any request with a browser `Origin`.
- **The shared session** (`CollabServer`) is the one part that listens beyond localhost — only while
  you start one from Settings, and only on your own WiFi:
  - joining needs the 6-character code on your screen; each joiner then gets their own token, and
    kicking them revokes it. The code is never the token.
  - joiners see exactly three things: the private Mac's screen, the session's group chat, and the
    **names and inputs** of your skills. Never your keys, vault, memory, own screen, browser tabs or
    skill step pictures. It shares okidoki's Mac, never yours.
  - a joiner's task runs in the private Mac, and anything risky still waits for **your** okay in the
    notch. The wheel is one driver at a time, you can reclaim it anytime, and ending the session
    stops the listener and disconnects everyone.
  - macOS 15+ asks once for Local Network permission; if it's denied the panel says so instead of
    sharing blindly.
- **Vault logins** are sealed in the panel with your passphrase (PBKDF2, 200k rounds, then AES-GCM)
  before they reach the Mac. Only ciphertext is stored.
- **Passwords** are never typed by computer use. Admin prompts go straight to macOS through a
  native dialog and are never stored.
