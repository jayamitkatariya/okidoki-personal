import type { OkidokiAgentAbilityDescriptor } from '../types';
import { COMPUTE_SANDBOX_WORKDIRS, MACOS_SANDBOX_MAX_TIMEOUT_MINUTES } from '../../../routes/compute';

const WORKDIR = COMPUTE_SANDBOX_WORKDIRS.macos;

const SECTION = `### macOS sandboxes
Build and test Apple apps (Xcode builds, iOS Simulator, Swift, macOS-only tools) on cloud Macs with \`okidoki macos\`. The workspace itself runs Linux.

**Reference:** \`references/MACOS.md\`

Use this when:
- A task needs macOS or Xcode: building an iOS or macOS app, running XCTest, booting an iOS Simulator, or a macOS-only tool`;

const REFERENCE = `# macOS sandboxes

\`okidoki macos\` starts a cloud Mac (Apple silicon, Xcode, iOS Simulator runtimes, Homebrew, git, Node, Python) and runs commands on it. It is authenticated automatically, and usage is billed at cost to the organization, so stop Macs when you are done.

\`\`\`bash
okidoki macos create
okidoki macos push                                # . -> ${WORKDIR}
okidoki macos exec -- xcodebuild -version
okidoki macos exec -- "cd ios && xcodebuild -scheme App -destination 'platform=iOS Simulator,name=iPhone 17' build"
okidoki macos exec -- "xcrun simctl boot 'iPhone 17' && xcrun simctl io booted screenshot shot.png"
okidoki macos pull ${WORKDIR}/shot.png ./
okidoki macos delete
\`\`\`

- Commands run with \`sh -c\` in \`${WORKDIR}\` as an admin user; quote shell operators. Use \`echo revyl | sudo -S <command>\` when a command needs root.
- A Mac runs one command at a time; others wait for it. Each command can run for up to an hour, and its output (first 1 MiB) arrives when it exits, so pipe long logs through \`tail\`.
- Background processes (\`&\`, \`nohup\`) end with the command that started them. Boot a simulator and use it in the same command, or leave it booted with \`xcrun simctl boot\`, which keeps running.
- \`--sandbox <id>\` picks a Mac when more than one is running; \`okidoki macos list\` shows them.
- Pass secrets per command with \`--env KEY=value\`; never push them in files.
- Push source rather than build output, and pull only results such as screenshots, logs, and \`.app\` bundles; transfers are capped at 1 GiB.

## Limits

- Lifetime 1 hour by default, up to ${MACOS_SANDBOX_MAX_TIMEOUT_MINUTES} minutes with \`--timeout\`. Nothing on a Mac is kept after it stops.
- Macs stop when this workspace sleeps, is archived, or is deleted; pull results before finishing.
- Macs are shared across organizations, so a create can fail when none are free; retry after a few minutes.
`;

export const MACOS_ABILITY: OkidokiAgentAbilityDescriptor = {
  label: 'macOS sandboxes',
  description: 'Build and test iOS and macOS apps with Xcode and the iOS Simulator on cloud Macs with `okidoki macos`.',
  bullet: '- Building and testing iOS or macOS apps (Xcode, iOS Simulator, Swift) on cloud Macs with `okidoki macos`',
  section: SECTION,
  referenceFile: { name: 'MACOS.md', content: REFERENCE },
};
