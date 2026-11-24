import type { OkidokiAgentAbilityDescriptor } from '../types';

const SECTION = `### The user's computer
Run commands on the user's own Mac or Linux computer over \`ssh <name>\`, such as an Xcode build, a simulator, or a tool that only exists there. Your instructions name the computers this workspace can reach, either through the desktop app's local control or as devices. With none, ask the user for theirs with \`okidoki local-control request\`. To open or use an app on their Mac, use \`okidoki computer mac\` instead (\`references/COMPUTER-USE.md\`), so the user's view never switches.

**Reference:** \`references/LOCAL-COMPUTER.md\`

Use this when:
- A task needs macOS, Xcode, the iOS Simulator, or hardware, files, or accounts that only the user's computer has
- The user asks you to run something "on my computer", "locally", or "on my Mac"`;

const REFERENCE = `# The user's computer

Your instructions list the computers you can reach and how: \`ssh <name>\`, \`scp\` and \`rsync\` work as usual. The desktop app can connect a computer after your instructions were written, so list every host you can reach now:

\`\`\`bash
grep '^Host' ~/.ssh/okidoki-devices/*.conf
\`\`\`

Hosts from a \`desktop-*.conf\` file connect through the desktop app. When one is the same computer as a device reached over the tailnet, use the desktop app host. If there are none, ask for the user's computer:

\`\`\`bash
okidoki local-control request --reason "Build and run the iOS app in the Simulator"
\`\`\`

It asks the user above the chat composer to let this workspace use their computer and to open the desktop app, waits until their computer connects, and prints its name. If it stops waiting first, end your turn and say what you need the computer for; you get a message when the user answers.

It is a personal machine with the user's files, accounts and running apps. Change only what the task needs, keep your files in one folder, and ask before anything destructive, slow to undo, or visible on their screen (bringing an app to the front, booting a simulator window, changing settings).

## Apps on a Mac: use \`okidoki computer mac\`, not \`ssh\`

To open or use an app (launch it, click, type, play music, read its window), use \`okidoki computer mac\` (see \`references/COMPUTER-USE.md\`). It keeps the app in the background, so the user's front window and focus stay theirs, and the user sees what you do in Okidoki. It takes no host: it drives the Mac connected through the desktop app (a \`desktop-*\` host). When you're working on a different computer, ask the user before using it. \`open\`, \`osascript\` and other commands over \`ssh\` can bring an app to the front and switch the user's view, and they don't show up in Okidoki.

Use \`ssh\` when it makes more sense: files, shell commands, builds, the Simulator through \`xcrun simctl\`, and quick read-only checks (\`osascript\` asking an app what it is doing) that change nothing on screen.

## Running commands

Other workspaces can reach the same computer at the same time, so keep everything you create (code, build output, logs, screenshots) under \`~/okidoki/<ws>\`, where \`<ws>\` is this workspace's \`$OKIDOKI_WORKSPACE_ID\`. The examples below use that folder.


- Quote the remote command in single quotes so the workspace shell doesn't expand it: \`ssh mac 'cd ~/okidoki/<ws>/app && make'\`. For multi-line scripts, pipe a heredoc into \`bash -s\`, since the login shell is often zsh:
  \`\`\`bash
  ssh mac 'bash -s' <<'EOF'
  set -euo pipefail
  cd ~/okidoki/<ws>/app
  xcodebuild -version
  EOF
  \`\`\`
- Commands run as the user in their home directory, with their login shell's \`PATH\` (Homebrew included) and no terminal. Anything that prompts hangs or fails: \`sudo\` needs a password, so use \`sudo -n\` and ask the user to run the command themselves if it refuses. Check a tool exists (\`command -v xcbeautify\`) before relying on it, and ask before installing one.
- Each new connection takes a few seconds. Batch related commands into one \`ssh\` call, or share one connection across calls:
  \`\`\`bash
  ssh -o ControlMaster=auto -o ControlPath=/tmp/ssh-%C -o ControlPersist=10m mac true
  ssh -o ControlPath=/tmp/ssh-%C mac 'xcrun simctl list devices booted'
  \`\`\`
- A command stops when its connection drops. For a build or job that runs longer than your tool's timeout, start it detached with a log, then poll the log:
  \`\`\`bash
  ssh mac 'cd ~/okidoki/<ws>/app && nohup xcodebuild build -scheme App > ~/okidoki/<ws>/build.log 2>&1 & echo $!'
  ssh mac 'tail -n 20 ~/okidoki/<ws>/build.log; kill -0 <pid> 2>/dev/null && echo running'
  \`\`\`
  A plain \`&\` without \`nohup\` dies with the connection.
- Through the desktop app, \`ssh -L\` and \`ssh -R\` port forwarding are refused. To reach a service running there, run the client there too (\`ssh mac 'curl -s localhost:3000/health'\`).

## Moving code and files

The user's computer doesn't have this workspace's checkout. Sync it into a folder of your own, never over the user's own clones unless they ask:

\`\`\`bash
rsync -az --delete --exclude node_modules --exclude .build --exclude DerivedData ./ mac:okidoki/<ws>/<repo>/
\`\`\`

Run the build there, then copy back what you need (logs, \`.xcresult\` bundles, screenshots) with \`scp\` or \`rsync\`. Edit code in the workspace and sync again, so the change stays in the workspace's git checkout.

## Xcode and the iOS Simulator (macOS)

\`\`\`bash
ssh mac 'xcodebuild -version; xcrun simctl list runtimes; xcrun simctl list devices available'
\`\`\`

- No runtime listed means no simulators: ask before running \`xcodebuild -downloadPlatform iOS\` (several GB).
- Build with \`-quiet\` and your own \`-derivedDataPath ~/okidoki/<ws>/DerivedData\`, so the output stays readable and the user's own builds aren't touched. Pipe through \`xcbeautify\` only if it's installed.
- \`xcrun simctl boot <udid>\` runs a simulator without opening its window. Install and launch with \`xcrun simctl install booted <App.app>\` and \`xcrun simctl launch booted <bundle id>\`, then screenshot with \`xcrun simctl io booted screenshot ~/okidoki/<ws>/sim.png\` and copy it back to share it with \`okidoki media upload\`. Shut down simulators you booted when you're done.

## When it fails

- \`ssh\` closes straight away, such as "Connection closed by UNKNOWN port 65535": through the desktop app, the app isn't running there or the user turned this workspace's access off: run \`okidoki local-control request\` to ask the user in the chat. Over the tailnet it can also mean this workspace hasn't joined it (\`tailscale status\`): use a desktop app host for that computer if there is one before asking the user to fix the tailnet.
- "Operation not permitted" or "authorization denied" on the user's files: macOS is blocking the app. Through the desktop app, a line saying so means the user has already been asked to turn on Full Disk Access: tell them why, and that it works once they restart Okidoki. Otherwise ask them to allow it under System Settings → Privacy & Security → Full Disk Access.
`;

export const LOCAL_COMPUTER_ABILITY: OkidokiAgentAbilityDescriptor = {
  label: 'User\'s computer',
  description: 'Run commands, builds and simulators on the user\'s own Mac or Linux computer over `ssh`.',
  bullet: '- Running commands on the user\'s own computer (`ssh <name>`), such as a local Xcode build or the iOS Simulator, or opening and using an app on their Mac in the background (`okidoki computer mac`, never `ssh` with `open` or AppleScript)',
  section: SECTION,
  referenceFile: { name: 'LOCAL-COMPUTER.md', content: REFERENCE },
};
