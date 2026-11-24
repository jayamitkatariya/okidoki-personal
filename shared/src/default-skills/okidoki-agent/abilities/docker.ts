import type { OkidokiAgentAbilityDescriptor } from '../types';

const SECTION = `### Docker
Start and use the Docker daemon in Okidoki workspaces. Docker is pre-installed but the daemon does not auto-start.

**Reference:** \`references/DOCKER.md\`

Use this when:
- You need to run \`docker\` or \`docker compose\` commands
- You need to build or run Docker containers
- Your task involves containerized services or Docker-based workflows`;

const REFERENCE = `# Docker

Docker is pre-installed in Okidoki workspaces, but the daemon does **not** auto-start. You must start it manually before running any \`docker\` or \`docker compose\` commands.

## Starting the Docker Daemon

\`\`\`bash
sudo service docker start
until docker info >/dev/null 2>&1; do sleep 0.2; done
\`\`\`

\`service docker start\` returns before the socket is accepting connections, so immediate commands may fail without the poll.

## Important Notes

- **Start once per session.** The daemon stays running until the workspace shuts down. You do not need to restart it between commands.
- **Check before starting.** If you are unsure whether the daemon is already running, check first to avoid an unnecessary restart:
  \`\`\`bash
  docker info >/dev/null 2>&1 || { sudo service docker start && until docker info >/dev/null 2>&1; do sleep 0.2; done; }
  \`\`\`
- **Sudo is only required for starting the daemon.** The workspace user is in the \`docker\` group, so regular \`docker\` commands work without sudo.
`;

export const DOCKER_ABILITY: OkidokiAgentAbilityDescriptor = {
  label: 'Docker',
  description: 'Start the daemon, build/run containers, drive `docker compose`.',
  bullet: '- Using Docker (starting the daemon, running containers, docker compose)',
  section: SECTION,
  referenceFile: { name: 'DOCKER.md', content: REFERENCE },
};
