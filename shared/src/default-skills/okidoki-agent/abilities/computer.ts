import type { OkidokiAgentAbilityDescriptor } from '../types';

const SECTION = `### Computer use (Linux desktop control)
Drive the workspace's Linux desktop - open a browser, click, type, scroll, screenshot, record - via the \`okidoki computer\` CLI. Every Okidoki workspace boots with a live H.264 and Opus stream published as an authenticated preview, so a \`Desktop\` tab is always available in the dashboard. Use \`okidoki computer info\` to get the viewer URL when you want to share it (e.g. point a user on Slack at the live stream).

**Reference:** \`references/COMPUTER-USE.md\`

Use this when:
- A task requires interacting with a website, web app, or desktop application that has no usable API
- You want the user to watch the agent work - they can open the \`Desktop\` tab, or you can share the URL from \`okidoki computer info\`
- You're testing UI changes in a browser before reporting them as done
- You want to record a screen capture of a task as proof to share back
- You need to open or use an app on the user's Mac: use \`okidoki computer mac\`, never \`ssh\` with \`open\` or AppleScript, which can switch the user's view`;

const REFERENCE = `# Computer use (Linux desktop control)

Every Okidoki workspace boots with a full Linux desktop stack - Xvfb (1920×1080), openbox, tint2, PulseAudio, ffmpeg, and Google Chrome. The engine auto-registers the H.264 and Opus viewer (port 6080) as an authenticated preview at startup, so the dashboard \`Desktop\` tab is live the moment the workspace is up. You drive the desktop through the \`okidoki computer\` CLI.

Use this for anything the user can't reasonably do via an API - clicking around web apps, filling forms, testing UI changes, dragging files between desktop apps, recording a walkthrough.

## When to use it

- **Prefer real APIs first.** If a task has a CLI or HTTP API (GitHub, Linear, Slack, Okidoki itself), use that. Driving a UI is slower, flakier, and less auditable.
- **Use it when there's no API**: testing a frontend you just changed, navigating a vendor portal, demonstrating a flow on video.
- **Use it when the user wants to watch.** The dashboard already shows a \`Desktop\` tab. If you're talking to the user somewhere else (e.g. Slack), call \`okidoki computer info\` to get the viewer URL and paste it in.

## Never use raw \`xdotool\` / \`scrot\` / \`ffmpeg\` directly

The CLI is the canonical surface. Chat transcripts that show \`DISPLAY=:99 xdotool key Return\` are noisy and break when the underlying stack changes. Always call the CLI:

\`\`\`bash
# DO
okidoki computer key Return
okidoki computer observe /tmp/state.jpg

# DON'T
DISPLAY=:99 xdotool key Return
scrot /tmp/state.png
\`\`\`

## Quickstart

\`\`\`bash
# 1) (Optional) Get the live viewer URL so you can share it with the user.
#    The desktop is already running and the preview is already registered -
#    this just looks up the URL.
okidoki computer info

# 2) Launch a browser on the workspace display.
okidoki computer launch chrome https://news.ycombinator.com

# 3) Capture the settled viewport and native accessibility tree together.
okidoki computer browser-state /tmp/state.jpg --full

# 4) Batch actions that use refs from the same state, then capture the semantic diff.
okidoki computer browser-batch '[{"action":"fill","ref":17,"value":"hello"},{"action":"click","ref":42}]'

# 5) (Optional) Record a screencap to share back.
okidoki computer record start /tmp/demo.mp4 --fps 60
# ... do stuff ...
okidoki computer record stop
okidoki media upload /tmp/demo.mp4 --name "Demo recording"
\`\`\`

For any external destination, continue with the required delivery flow in \`MEDIA.md\`.

## Command reference

### \`okidoki computer info\`
Prints the live desktop viewer URL (\`https://6080-<hash>.okidoki.dev/\`). The engine auto-registers this authenticated preview on startup; \`info\` just looks it up. Use it when you want to share the live stream URL with the user out-of-band (e.g. in a Slack reply) - the dashboard \`Desktop\` tab already points at the same URL automatically.

If invoked very early in the workspace lifecycle, \`info\` will poll briefly while the engine finishes registering the preview, then error if it's still not available.

### \`okidoki computer status\`
Checks and repairs the desktop bridge, then prints which desktop services are running and the active preview URL (if any). Useful for debugging when a tool call seems to be doing nothing.

### \`okidoki computer screenshot <path> [--raw] [--grid [px]]\`
Captures the current desktop to the given path. The extension picks the format; \`.jpg\` captures several times faster than \`.png\`.

Use \`--raw\` for a 1:1 desktop capture with no branding, padding, or rounded corners. Use \`--grid\` for the same 1:1 capture plus a coordinate grid; the optional value sets grid spacing in pixels and defaults to 100. Use the default branded screenshot only when you plan to share the image with \`okidoki media upload\`.

### \`okidoki computer observe <path> [--grid [px]] [--timeout MS] [--stable-ms MS] [--poll-ms MS]\`
Waits briefly for the screen to stop changing, saves a 1:1 screenshot, and prints JSON with screen dimensions, whether the screen stabilized, frame/change counts, mouse location, active window title, and visible window titles.

Use this instead of hand-written \`sleep && screenshot\` loops after clicks, navigation, typing, or page loads. It waits up to 3s for 600ms of visual stability. Use a \`.jpg\` path for the fastest capture. \`--grid\` overlays a coordinate grid.

### \`okidoki computer browser-state [path] [--full] [--timeout MS] [--stable-ms MS]\`
Waits until the selected Chrome page has been quiet for 500ms (immediately if it already has), then prints a compact native Chrome accessibility tree. Pass a path to also save a viewport screenshot in the same coordinate space. Nodes other than text have DOM-backed refs such as \`[ref=42] button "Save"\` or \`[ref=7] region "Done"\`; elements that only look clickable (a pointer cursor and no accessible role) appear as \`clickable\`. The tree includes accessible roles, names, values, states, visible bounds, and iframe content.

The first call returns a full tree. Later calls for the same target and document return semantic changes; navigation or reload forces a new full tree. Pass \`--full\` to reset the baseline. Refs are valid for the current document.

Every browser action below (\`browser-click\`, \`browser-fill\`, \`browser-drag\`, \`browser-scroll\`, \`browser-key\`, \`browser-type\`, \`browser-batch\`) waits for the page to settle and ends its output with an \`observation\`: the same tree changes \`browser-state\` would print, including refs for new elements. Read it instead of calling \`browser-state\` again.

### \`okidoki computer browser [--snapshot]\`
Lists Chrome tabs. \`--snapshot\` returns the compatibility accessibility snapshot. Use \`browser-state\` for the primary action/observe loop.

### \`okidoki computer browser-batch '<actions-json>'\`
Runs up to 100 ordered browser actions through one Chrome session and stops at the first failure. Supported actions are \`click\`, \`fill\`, \`drag\` (\`{"action":"drag","ref":3,"toRef":9}\`), \`key\`, \`type\`, \`scroll\`, and \`wait\`. Prefer this when several actions use refs from the same state; it avoids repeated process, tab-selection, and connection setup. The observation after the batch (or after a failure) carries the refs for the next step. Do not carry refs across navigation.

### \`okidoki computer browser-click --ref ID [--button left|middle|right] [--double]\`
Scrolls the referenced node into view and sends trusted Chrome mouse input at its current visible bounds. Prefer refs from \`browser-state\`. \`browser-click <text> [--exact] [--index N]\` remains a fallback when no fresh ref is available.

### \`okidoki computer browser-fill --ref ID <value>\`
Focuses the referenced field, fills it with trusted Chrome input, and verifies the resulting value. Selects take an option's value or label; range sliders and number, date, time and color inputs take their value directly (\`browser-fill --ref 12 75\` sets a slider to 75). \`browser-fill <field> <value> [--exact] [--index N]\` remains a text-matching fallback.

### \`okidoki computer browser-drag --ref ID --to-ref ID\`
Drags one element onto another with trusted mouse input, including HTML5 drag-and-drop. Both refs come from the latest state and should be visible together.

### \`okidoki computer browser-scroll <up|down|left|right> [--ref ID] [--amount PX] [--until TEXT] [--timeout MS]\`
Sends trusted wheel input at a referenced element. Without \`--ref\` it scrolls the page, or the largest visible scrollable panel when the page itself does not scroll. \`--until <text>\` keeps scrolling, letting lazy-loaded content arrive, until the text is on the page, then centers it; it fails if the content ends or \`--timeout\` (default 10000) passes first. Use it instead of scrolling in a loop.

### \`okidoki computer browser-key <combo>\` / \`browser-type <text>\`
Sends trusted keyboard input to the focused element in the selected Chrome target. Prefer \`browser-fill\` when setting a known field value.

### \`okidoki computer browser-wait <text> [--mode any|text|title|url|control] [--exact] [--timeout MS]\`
Waits until the active Chrome page matches text in the title, URL, body text, or visible controls. Use this after \`browser-click\` / \`browser-fill\` when you need web app state to settle without screenshot polling.

For browser state and actions, pass \`--target-id <id>\`, \`--title <text>\`, \`--url <text>\`, or \`--page <n>\` when multiple Chrome tabs are open. Prefer \`--target-id\` because titles and URLs can change after an action. The matched tab is brought to the foreground before each action, so driving multiple tabs or recording the screen switches which tab is visible.

### \`okidoki computer click <x> <y> [--button N] [--double] [--modifiers ctrl+shift]\`
Move to (x, y) and click. Coordinates can be absolute pixels or percentages such as \`50%\` \`50%\`. Default is left-click (button 1); pass \`--button 3\` for right-click. \`--modifiers\` holds keys during the click (e.g. ctrl-click a link to open in a new tab).

### \`okidoki computer move <x> <y>\`
Move the mouse without clicking. Coordinates can be absolute pixels or percentages. Useful for hovering tooltips.

### \`okidoki computer type <text> [--delay MS]\`
Type a literal string into the focused field. Default per-character delay is 12ms (~80 wpm) - feels human and avoids breaking apps that debounce input. Bump \`--delay 30\` for stricter apps.

For key combos (not literal text), use \`key\`. \`type "ctrl+l"\` will literally type the seven characters \`c t r l + l\`.

### \`okidoki computer key <combo>\`
Press a single key or combo. Examples: \`Return\`, \`Escape\`, \`Tab\`, \`ctrl+l\`, \`ctrl+shift+t\`, \`alt+Left\`, \`Page_Down\`, \`Home\`. Syntax matches \`xdotool key\`.

### \`okidoki computer scroll <up|down|left|right> [--amount N] [--x X --y Y]\`
Scroll the wheel. Pass \`--x\` / \`--y\` to hover before scrolling (otherwise scrolls wherever the cursor currently is). Hover coordinates can be absolute pixels or percentages. Default amount is 3 wheel ticks.

### \`okidoki computer drag <fromX> <fromY> <toX> <toY>\`
Press left mouse at (fromX, fromY), drag to (toX, toY), release. Coordinates can be absolute pixels or percentages. For things like dragging a file onto an upload zone.

### \`okidoki computer launch <app> [args...]\`
Spawns an app on the workspace display. Built-in aliases:
- \`chrome\` - Google Chrome with a clean profile and sane flags
- \`chromium\` - Chromium variant
- \`firefox\` - Firefox
- \`terminal\` - xfce4-terminal (modern, themed); \`xterm\` for the classic
- \`notepad\` / \`editor\` - mousepad (lightweight GTK text editor)
- \`files\` / \`filemanager\` - thunar (file manager)
Anything else gets \`exec\`'d verbatim, so \`okidoki computer launch xeyes\` works if xeyes is installed.
When opening a known page, prefer passing the URL directly: \`okidoki computer launch chrome http://localhost:3000/\`.

Chrome launches do not return until the requested page is controllable. The output includes its page ID; carry that ID with \`--target-id\` into \`browser-state\` and browser actions so unrelated tabs cannot steal task context.

### \`okidoki computer record start <path> [--fps N]\`
Starts an ffmpeg screen recorder and returns only after ffmpeg has written the first bytes. Output is post-processed when stopped: action windows stay at normal speed, idle gaps accelerate, click moments get eased camera zoom, and a synthetic cursor animates between logged mouse positions. The raw capture is fragmented MP4 while active (still playable if the workspace dies mid-record). Default 60fps; drop to 30 if the workspace is CPU-constrained.

Only one recording at a time. Re-running \`start\` while one is active fails - call \`stop\` first.

### \`okidoki computer record stop\`
SIGINTs ffmpeg, verifies that the process has finalized the MP4, then prints the output path. A finalization timeout preserves the recording state so \`stop\` can be retried safely. To show the interaction in a PR or message, turn it into a short looping GIF with \`okidoki media gif <path>\`, then upload with \`okidoki media upload <path> --name "<name>"\`.

### \`okidoki computer mac <tool> ['<json>'] [--screenshot PATH] [--session NAME]\`
Drives one app on the user's own Mac in the background, while they keep working: their cursor, focus and front window stay theirs. It works over the desktop app's local control (see \`references/LOCAL-COMPUTER.md\`); when no Mac is connected, it says so and you ask with \`okidoki local-control request\`. Each call runs one [Cua Driver tool](https://cua.ai/docs/cua-driver), and the user watches the window you're working in from the dashboard. If the driver reports missing Accessibility or Screen Recording permission, ask the user to allow Okidoki in System Settings → Privacy & Security.

Start with \`list_apps\` or \`launch_app '{"bundle_id":"com.apple.TextEdit"}'\` (never \`open\`, which brings the app forward), then \`get_window_state '{"pid":…,"window_id":…}'\` for the accessibility tree and a screenshot (\`--screenshot\` saves it), then act with \`click\`, \`type_text\`, \`press_key\`, \`set_value\` or \`scroll\` by \`element_token\`, and read the window again to verify. Type line breaks as a separate \`press_key\` Return: a newline inside \`type_text\` is dropped. Pass the same \`--session\` to keep element tokens valid across calls. Apps that open no window when launched in the background show one once you open a file with \`launch_app\`'s \`urls\`. \`get_guide\` explains everything else. Some actions, like a disabled menu item, need the app in front: ask the user before \`bring_to_front\`.

## Patterns

### Browser action / state loop
For Chrome, use the native accessibility state before interpreting pixels or guessing coordinates:

\`\`\`bash
okidoki computer launch chrome https://example.com
okidoki computer browser-state --full --target-id <page-id>
okidoki computer browser-batch '[{"action":"fill","ref":17,"value":"hello"},{"action":"click","ref":23}]' --target-id <page-id>
\`\`\`

Batch ordered actions whose refs all come from the latest state, then read the observation the batch prints: it is the next semantic diff. A batch is fail-fast and validates each ref against the cached document. Split at navigation or whenever a later action depends on newly rendered refs. Pass a screenshot path to \`browser-state\` when the tree alone is ambiguous (icons, colors, canvas). Fall back to \`observe\` plus desktop coordinates for canvas content, browser chrome, non-Chrome apps, or controls missing from the accessibility tree.

### Typing into an address bar
\`\`\`bash
okidoki computer launch chrome
okidoki computer observe /tmp/browser-open.jpg
okidoki computer key ctrl+l
okidoki computer type "https://example.com"
okidoki computer key Return
okidoki computer browser-state --full
okidoki computer browser-fill --ref 17 "okidoki"
okidoki computer browser-click --ref 23 --title "Example"
okidoki computer browser-wait "Example Domain" --mode title --title "Example"
\`\`\`

### Coordinates from screenshots
The display is 1920×1080 by default. For click planning, use \`observe\`, \`screenshot --raw\`, or \`screenshot --grid\`; those pixels map 1:1 to click coordinates. If the screenshot shows a button at pixel (520, 700), click \`okidoki computer click 520 700\`. The default screenshot is branded for sharing and has padding around the desktop, so do not use it for coordinates.

Use percentages for broad, layout-relative targets when exact pixels are unnecessary: \`okidoki computer click 50% 50%\` clicks the center of the screen, and \`okidoki computer move 95% 5%\` moves near the top-right.

Modern image-reading models often imagine the screenshot is at a different resolution. Trust the dimensions printed by \`observe\`, \`okidoki computer screenshot ... --raw\` / \`--grid\`, and the \`xdpyinfo\` value shown by \`okidoki computer status\`.

### Letting the user watch
The Desktop tab is already live in the dashboard - the user can open it any time. If you're communicating with the user somewhere else (Slack, PR comment, etc.), grab the URL with \`okidoki computer info\` and share it inline so they can watch you work.

### Recording a deliverable
For tasks the user wants proof of:
\`\`\`bash
okidoki computer record start /tmp/walkthrough.mp4
# ... your work ...
okidoki computer record stop
okidoki media gif /tmp/walkthrough.mp4 --duration 8
okidoki media upload /tmp/walkthrough.gif /tmp/walkthrough.mp4 --name "Walkthrough" --name "Walkthrough recording"
\`\`\`
Then embed the printed \`![…](…)\` lines in your chat reply and follow \`MEDIA.md\` for any external destination: the GIF goes inline in PRs, and a grid of extracted frames never does.

## Failure modes

- **"Computer-use daemon is unavailable"**: the package-managed systemd service did not start. Check \`systemctl status okidoki-computer.service\` and its journal.
- **"Desktop services script missing"**: workspace image is older than this skill. Tell the user - nothing you can do from the CLI side.
- **\`xdotool ... failed: Can't open display\`**: Xvfb didn't come up. \`okidoki computer status\` will show which service is dead and auto-repair the desktop bridge.
- **Browser doesn't appear after \`launch chrome\`**: run \`okidoki computer observe /tmp/state.jpg\`. Chrome cold-start on the virtual display takes ~500ms but bigger pages take longer.
- **Live preview shows static / black screen**: the browser may have crashed. \`okidoki computer status\` should show no Chrome process - re-launch.
- **\`okidoki computer info\` errors with "not registered"**: engine couldn't register the preview at startup (transient monolith error, or warming mode). Re-running the engine usually fixes it. Until it's registered, the Desktop tab will show a placeholder.

## What gets baked in vs. lazy

| Component | Where |
|---|---|
| \`xvfb\`, \`openbox\`, \`tint2\`, \`pulseaudio\`, \`xautomation\`, \`xdotool\`, \`scrot\`, \`ffmpeg\`, \`google-chrome\` | Baked into the workspace image |
| \`okidoki-computer\`, desktop assets, and service unit | Installed by \`okidoki-computer setup\` during the image build |
| Xvfb / openbox / tint2 / PulseAudio / stream processes | Managed by \`okidoki-computer.service\` |
| Desktop stream URL (port 6080) | Registered by the engine on startup (authenticated) |
| Dashboard \`Desktop\` tab | Always available once the engine has registered the preview |

You can call any of the input tools (\`click\`, \`type\`, \`screenshot\`, etc.) immediately - the daemons are already running.
`;

export const COMPUTER_ABILITY: OkidokiAgentAbilityDescriptor = {
  label: 'Computer use',
  description: "Drive the workspace's Linux desktop and stream a live H.264 and Opus viewer.",
  bullet:
    '- Driving the workspace Linux desktop (open a browser, click, type, scroll, screenshot, record) and exposing a live audio and video stream in the dashboard',
  section: SECTION,
  referenceFile: { name: 'COMPUTER-USE.md', content: REFERENCE },
};
