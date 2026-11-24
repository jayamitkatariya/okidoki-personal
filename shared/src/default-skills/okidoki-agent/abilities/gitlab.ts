import type { OkidokiAgentAbilityDescriptor } from '../types';

const SECTION = `### GitLab
Use plain git for repository traffic and the workspace-scoped TypeScript SDK for GitLab API operations.

**Reference:** \`references/GITLAB.md\`

Use this when:
- A repository remote is on gitlab.com or a self-managed GitLab instance
- You need to open or update a merge request
- You need GitLab issues, pipelines, comments, or other API data`;

const REFERENCE = `# GitLab Integration

Git credentials are preconfigured for fetch, pull, and push. Use \`@okidoki/sdk\` for API traffic; never inspect \`~/.git-credentials\`, request a token, or send a credential with curl.

## Merge requests

Create a merge request directly from a push:

\`\`\`bash
git push -o merge_request.create -o merge_request.target=<default-branch> -o merge_request.title="Title" origin HEAD
\`\`\`

Useful options are \`-o merge_request.draft\` and \`-o merge_request.remove_source_branch\`. GitLab prints the merge request URL.

## API requests

Pass a relative path below \`/api/v4\`. Okidoki selects the credential only from GitLab hosts attached to the workspace repositories.

\`\`\`ts
import { okidoki } from '@okidoki/sdk';

const project = encodeURIComponent('group/project');
const mergeRequests = await okidoki.gitlab.request(
  \`/projects/\${project}/merge_requests?state=opened\`,
);

await okidoki.gitlab.request(\`/projects/\${project}/issues/42/notes\`, {
  method: 'POST',
  body: { body: 'Update from Okidoki' },
});
\`\`\`

When a workspace contains repositories from more than one GitLab host, pass the exact repository host:

\`\`\`ts
await okidoki.gitlab.request('/projects/group%2Frepo/pipelines', {
  host: 'gitlab.example.com',
});
\`\`\`

## Descriptions and media

API updates replace the entire merge request description, so always preserve the required Okidoki footer and co-author trailers. Media delivery is owned by \`references/MEDIA.md\`; read its GitLab section before adding media so the original bytes are uploaded to Okidoki and GitLab.
`;

export const GITLAB_ABILITY: OkidokiAgentAbilityDescriptor = {
  label: 'GitLab',
  description: 'Git for repository traffic and @okidoki/sdk for the GitLab API.',
  bullet: '- Interacting with GitLab (pushing to GitLab repos, opening merge requests)',
  section: SECTION,
  referenceFile: { name: 'GITLAB.md', content: REFERENCE },
};
