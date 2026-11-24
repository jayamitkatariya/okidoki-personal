import type { OkidokiAgentAbilityDescriptor } from '../types';

const SECTION = `### Previews
Expose locally running services (web apps, APIs, databases) as public preview URLs so humans can interact with them directly.

**Reference:** \`references/PREVIEWS.md\`

Use this when:
- You need to start a service that a human should view or interact with
- The task involves UI work that benefits from human review
- You are verifying frontend/backend integrations visually
- You need a URL for OAuth redirects, GitHub App callbacks, or webhooks (never the sandbox's \`*.sandbox.tensorlake.ai\` address)`;

const REFERENCE = `# Preview URLs

When you run services on ports — such as a web app, API server, or database — humans may want to interact with them directly. You can expose your locally running services as public preview URLs.

## Running Services for Preview

Always start services with \`okidoki service start\` (see \`OKIDOKI.md\`, "Long-running services"). It daemonizes the process so it survives your turn ending and workspace sleep/wake — a service left attached to your shell or backgrounded with \`&\`/\`nohup\` dies when the workspace sleeps, leaving the preview broken for the user.

\`\`\`bash
okidoki service start web "yarn dev" --cwd /path/to/app
\`\`\`

After starting a service:
1. Check logs for readiness: \`okidoki service logs web\`
2. Confirm it's actually serving: \`curl -s http://localhost:3000\` (or appropriate health check)
3. Only create the preview after the service is healthy

\`okidoki service start\` on the same name restarts the service, so you never need to hunt down stale processes on the port.

## Creating Previews

\`\`\`bash
# Expose a local port as a public URL
okidoki preview create <port>

# Expose a port with authentication (requires Okidoki login to access)
okidoki preview create <port> --authenticated

# List all active preview URLs
okidoki preview list
\`\`\`

The \`create\` command prints the public URL. You can also read all active previews from \`~/.okidoki/preview-ports.json\`.

## Authenticated vs Unauthenticated Previews

Previews can optionally require cookie-based authentication. When \`--authenticated\` is set, only users who are logged in to okidoki.dev can access the preview.

**When to use \`--authenticated\`:**
- Frontends / web apps that humans will view directly in their browser. Since the user is already logged in to okidoki.dev, the auth cookie is automatically present and the preview works seamlessly.

**When NOT to use \`--authenticated\`:**
- Backend APIs and other services that are called by frontend code. The frontend runs in the user's browser under a different origin, so it cannot forward the Okidoki auth cookie to the backend. Making backends authenticated will cause cross-service requests to fail with 401 errors.

**Rule of thumb:** Make frontend previews authenticated, leave backend/API previews unauthenticated.

## OAuth Redirects, App Callbacks, and Webhooks

Never use the sandbox's raw \`https://<port>-<sandbox-id>.sandbox.tensorlake.ai\` address anywhere a browser or third party will load it. It only accepts requests carrying a key that the Okidoki preview proxy adds, so browsers, OAuth providers, and webhook senders are rejected.

Use the port's preview URL instead:
- As the app's public base URL (\`APP_URL\`, \`NEXTAUTH_URL\`, and similar)
- For OAuth redirect URIs and GitHub App callback and setup URLs
- For webhook URLs (GitHub, Stripe, Slack, and others)

OAuth and GitHub App redirects happen in the browser, so they work on an \`--authenticated\` preview when the person is logged in to Okidoki. Webhooks and other server-to-server calls carry no Okidoki login, so the port receiving them needs a preview without \`--authenticated\`. That makes the whole port public to anyone with the URL: tell the user, and verify webhook signatures in the app.

A preview URL stays the same for a workspace and port, so register it with the provider once. Other workspaces get different URLs.

## Cross-Service References

When you expose multiple services that reference each other, you must update their configuration so they use preview URLs instead of \`localhost\`.

**Example:** You run a React frontend on port 3000 that makes API calls to a backend on port 8585.

1. Create previews for both:
   \`\`\`bash
   okidoki preview create 8585
   # Output: https://8585-<hash>.okidoki.dev
   okidoki preview create 3000 --authenticated
   # Output: https://3000-<hash>.okidoki.dev
   \`\`\`

2. Update the frontend's environment so its API base URL points to the backend's **preview URL**, not \`localhost:8585\`. For example, set \`REACT_APP_API_URL=https://8585-<hash>.okidoki.dev\` or update the relevant config file.

**Why?** The frontend works on \`localhost\` for you because both services run on the same machine. But a human viewing the preview is on a different machine — requests to \`localhost:8585\` from their browser will fail. They need the public preview URL instead.

## When to Create Previews

- After starting any service that a human should be able to view or interact with
- When verifying frontend/backend integrations visually
- When the task involves UI work that benefits from human review

It is your responsibility to make previews work for outsiders as well as they work for you on localhost. If at any time you need to see the public URLs that have been created, read \`~/.okidoki/preview-ports.json\`.
`;

export const PREVIEWS_ABILITY: OkidokiAgentAbilityDescriptor = {
  label: 'Previews',
  description: 'Expose locally running services on public preview URLs for humans.',
  bullet: '- Creating preview URLs for locally running services, including OAuth redirect, app callback, and webhook URLs (never a raw `*.sandbox.tensorlake.ai` address)',
  section: SECTION,
  referenceFile: { name: 'PREVIEWS.md', content: REFERENCE },
};
