import type { OkidokiAgentAbilityDescriptor } from '../types';

const SECTION = `### Media
Deliver screenshots, GIFs, screen recordings, generated diagrams, and audio clips to the Okidoki dashboard and, when applicable, inline in the destination workflow.

**Reference:** \`references/MEDIA.md\`

Use this when:
- You are about to run \`okidoki media upload\`; this reference owns the complete Okidoki-first, destination-second workflow
- You produce a screenshot, recording, generated image, or audio clip the user should see
- You need to show motion or an interaction (an animation, a popup that moves, a flow) in a PR or message: make a short looping GIF with \`okidoki media gif\`, never a grid of frames
- You record video output (browser automation, screen capture) — including the recommended aspect ratio and FPS
- You need to embed media in a Slack/Linear/GitHub/GitLab message AND keep a referenceable copy in the Okidoki dashboard`;

const REFERENCE = `# Media (Screenshots, GIFs, Recordings, Audio)

This is the single source of truth for delivering screenshots, GIFs, screen recordings, generated diagrams, and audio clips through Okidoki and external surfaces (Slack, Linear, GitHub, GitLab). HTML pages are visuals: publish them with \`okidoki visualize\` (see \`okidoki visualize --help\`), not \`media upload\`.

## Always

- Every picture, GIF, recording, or visual you mention in your reply to the user shows up in that reply: paste its printed \`![…](…)\` line on its own line. Do this even when you also posted it to a PR, Slack, Linear, or GitLab, and even when the task came from one of them.
- Never send the user somewhere else to see it ("see the Canvas", "check the media tab"). Uploads also appear in the Canvas's media folder, so they stay there for later.
- Keep the whole \`okidoki media upload\` output. Don't pipe it through \`tail\`, \`grep\`, or \`head\`; you need every line it prints.

## Prerequisites

The \`okidoki\` CLI is pre-installed and authenticated in your workspace. No additional setup is needed.

## Screenshot, GIF, or recording

Pick the format from what the reader has to see:

- **Static UI** (a layout, a new button, an error message): still screenshots.
- **Motion or an interaction** (an animation, a popup that moves or flickers, a drag, a short multi-step flow): a short looping GIF. It plays inline in GitHub, Slack, Linear, GitLab, and Okidoki chat, with no click and no sign-in.
- **A long walkthrough, or anything with sound**: the MP4 recording, shown as a GIF or poster that links to it (see GitHub below).

Never paste a contact sheet or grid of frames extracted from a recording, and never paste a run of separate frame screenshots. At PR width each frame is a thumbnail, and the reader can't tell what moved. Make a GIF instead.

### Make a GIF from a recording

\`\`\`bash
okidoki computer record start /tmp/after.mp4 --fps 30
# ... perform only the interaction ...
okidoki computer record stop
okidoki media gif /tmp/after.mp4 --start 1 --duration 6
okidoki media upload /tmp/after.gif --name "Language menu after fix"
\`\`\`

\`okidoki media gif <recording>\` takes any MP4, WebM, or MOV (desktop, Playwright, CDP screencast, or simulator recordings) and writes a looping GIF next to it (\`-o\` to choose the path). It starts at 12 fps and 960 px wide and lowers both until the file is under 5 MiB. GitHub's image proxy returns 404 for larger images, so a bigger GIF shows as a broken image in the PR.

- Keep it to the interaction, usually 3–10 seconds: \`--start\` and \`--duration\` (default 10, max 30).
- When the change is small on a large screen, \`--crop w:h:x:y\` (recording pixels) to the area that changes so text stays readable. Use the same crop for the before and after GIFs.
- If it reports the GIF is still too large, show less: a shorter \`--duration\` or a tighter \`--crop\`.
- Upload the GIF like any image. Its printed \`![…](…)\` line is public and renders inline everywhere.
- Older workspaces may not have \`okidoki media gif\` yet (\`okidoki media gif --help\` fails). Use the same ffmpeg settings directly; keep \`-ss\` and \`-t\` before \`-i\` (palettegen waits for its input to end, so trimming after \`-i\` never finishes), and if the file is over 5 MiB, lower \`fps\` and the width and run it again:

\`\`\`bash
ffmpeg -v error -y -ss 1 -t 6 -i /tmp/after.mp4 \\
  -vf "fps=12,scale='min(960,iw)':-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \\
  -loop 0 /tmp/after.gif
\`\`\`

ffmpeg is baked into the workspace image. If it's missing, install it with \`sudo apt-get install -y ffmpeg\`.

### Before and after

Make comparisons easy to see at a glance, whether it's before and after or options to pick from. Capture each version the same way, so only the change differs, and say in one line what to look for. Crop to the part that changed, keep every version big enough to read, and make it clear which is which. Avoid tall full-page screenshots; at PR width the change is too small to see. A new feature usually only needs the after. For screenshots, a small HTML page with the crops, screenshotted at 2x, works well. For GIFs, a two-column Markdown table works well.

## When to upload

Upload to Okidoki in these cases — and **only** these cases:

1. **Media you show the user.** A screenshot, screen recording, generated diagram, or audio clip, once you decide to show it to the user or share it. Screenshots you take only to check your own work stay local. Upload before you delete the file or send it anywhere else. This applies even when you're also sending the file to Slack, Linear, GitHub, or GitLab.
2. **Files the user explicitly asks you to upload.** If the user sends or points at a file (image, video, audio) and asks you to upload it, run \`okidoki media upload\`. Otherwise leave it alone — files in the workspace the user did not ask about should not be auto-uploaded as media.
3. **Anything you plan to share externally (Slack, Linear, GitHub, GitLab, etc.).** Upload to Okidoki first, then follow the destination's delivery path below.

If none of these apply, don't upload.

## Required delivery contract

\`okidoki media upload\` is always the first delivery action. When the current task has an external destination, every other delivery step follows only after that command succeeds. For every file:

1. First, run \`okidoki media upload\` with the original file. Do not begin any destination upload until the command succeeds. This creates the canonical dashboard copy and prints an embed plus a per-file dashboard link. Every image gets a public link, so its printed embed works in chat and on GitHub.
2. Include the printed embed line in the Okidoki chat reply.
3. Identify every destination in the task and use its inline representation from the table below. Slack, Linear, and GitLab require an upload of the same original bytes; GitHub uses the image's printed public embed.
4. On Slack, attach the **View in Okidoki** dashboard link to the upload as a button (see the Slack flow below). On Linear, put it next to the destination embed as a secondary link. GitHub and GitLab need only the embed.
5. Check each destination response. If its upload or public link fails, say so explicitly and keep the dashboard link; never claim that a dashboard link is an inline embed.

| Destination | Required file delivery | Inline result |
|---|---|---|
| Okidoki dashboard/chat | \`okidoki media upload\` | Printed \`![…](…)\` line in chat |
| Slack | \`files.getUploadURLExternal\` → raw-byte POST → \`files.completeUploadExternal\` | Uploaded file in the channel or thread |
| Linear | \`fileUpload\` mutation → presigned upload → issue/comment mutation | Returned \`assetUrl\` in Markdown |
| GitLab | Project \`/uploads\` endpoint with the original bytes | Returned GitLab Markdown |
| GitHub | \`gh pr create --attach <image>\` (also \`edit\` and \`comment\`), or the printed public embed | Inline image, linked to the recording when needed |

The dashboard link is the subtitle and jump-back path. It is never a substitute for the destination embed.

## Uploading to Okidoki

\`\`\`bash
okidoki media upload <path-to-file> --name "<display name>" [<path-to-file> --name "<display name>" ...]
\`\`\`

Pass one or more file paths, each with a required \`--name\` (see below). Uploading several files in a single invocation is preferred over running the command repeatedly: it's faster and keeps the output grouped.

### Name each upload

\`--name\` is **required** and sets the short, human-readable display name shown in the Okidoki dashboard (the backend still tracks the asset by UUID). Make it descriptive of the content, e.g. \`login-page\`, \`checkout-error\`, or \`db-latency-chart\`. Never use a generic value like \`screenshot\` or \`image\`.

\`\`\`bash
okidoki media upload /tmp/shot.png --name "Login page after fix"
\`\`\`

Pass one \`--name\` per file, in the same order as the file paths:

\`\`\`bash
okidoki media upload /tmp/before.png /tmp/after.png --name "Before fix" --name "After fix"
\`\`\`

Names are normalized to hyphen-case (spaces become hyphens, e.g. \`Login page\` is stored as \`login-page\`). Give every asset a **distinct** name — duplicates are not rejected, but Okidoki keeps the first as-is and adds a \`-1\`, \`-2\` suffix to later collisions, which produces confusing lists, so pick unique names yourself.

For each media file, the CLI prints an embed line and a dashboard link:

1. Images always print \`![<name>](<public-url>)\`, using the \`--name\` you passed. This public, stable link works in Okidoki chat, GitHub, and anywhere else Markdown images render. No flag is needed.
2. Video and audio print \`Okidoki chat embed: ![<name>](<api-url>)\` by default; this authenticated URL renders inline in Okidoki chat **only** — see below. \`--access public\` prints a public link instead, \`[<name>](<public-url>)\`, which plays in Okidoki chat and opens the video anywhere else. Never put a video inside \`![…](…)\` or a \`<video>\` tag on GitHub: it shows as a broken image or disappears. Videos also print the PR line to paste once you have a GIF, already linked to the video.
3. \`View in Okidoki: <deep-link>\` is a per-file dashboard URL of the form \`https://app.okidoki.dev/workspaces/<workspace-id>?mode=media&media=<media-id>\` that opens directly to that specific file.

Match each "View in Okidoki" line to the embed line directly above it — that's the deep link for that file.

Video and audio stay private unless they must play without Okidoki sign-in; then pass \`--access public\` (alias \`--share\`):

\`\`\`bash
okidoki media upload demo.mp4 --name "Checkout demo" --access public
\`\`\`

Public links are unguessable bearer URLs: anyone with the link can view the file until it is rotated or revoked. Reuse the link printed at upload. \`okidoki media share <media-id>\` issues a new link and breaks the old one everywhere it is embedded, and \`okidoki media revoke <media-id>\` removes public access.

Permanently delete an upload with \`okidoki media delete <media-id>\`. The backend only permits deletion when the media belongs to the current workspace; media from another workspace returns not found.

## The URLs the CLI gives you — and where each one is allowed

| URL | What it is | Where it's allowed |
|---|---|---|
| \`https://api.okidoki.dev/v1/media/<id>\` (inside \`![…](…)\`) | Authenticated API redirect printed for private video, audio, and visuals — requires the Okidoki chat session | **Only** in the Okidoki chat reply. Nowhere else. |
| \`https://app.okidoki.dev/organizations/<organization-id>/media/<media-id>\` | Organization-only page (\`Forge link\`) printed for every visual, and for video or audio with \`--access organization\` | Pull requests and other places where every viewer belongs to the Okidoki organization. |
| \`https://api.okidoki.dev/v1/media/public/<id>/<token>\` | Public bearer URL printed for every image, and for video or audio with \`--access public\` | The Okidoki chat reply and GitHub embeds. |
| \`https://app.okidoki.dev/workspaces/<workspace-id>?mode=media&media=<media-id>\` | Authenticated dashboard deep link that opens the media file in the workspace | Everywhere external: Slack, GitHub, GitLab, Linear, PR bodies, comments, emails. |

### NEVER link the API redirect URL outside the Okidoki chat reply

The \`api.okidoki.dev/v1/media/<id>\` URL is **not public**. Image uploads never print it; if you have one for an image from an older upload, run \`okidoki media share <media-id>\` to get a public link. It's an authenticated redirect that only resolves to a presigned download when the Okidoki chat session token is present. Anywhere else (Slack, Linear, GitHub, a browser tab the user opens directly, a customer copy-pasting from chat) it returns \`{"error":"Missing authorization token"}\` and renders as a broken image.

This rule has no exceptions:
- ❌ Never paste it in a Slack message — upload the actual bytes via the 3-step \`files.getUploadURLExternal\` → POST bytes → \`files.completeUploadExternal\` flow instead (see below).
- ❌ Never paste it in a GitHub PR description, issue body, review comment, or commit message.
- ❌ Never paste it in a Linear issue body or comment — upload via Linear's \`fileUpload\` mutation instead (see below).
- ❌ Never paste it in a GitLab merge request or issue; upload the original bytes through GitLab's project upload endpoint instead (see below).
- ❌ Never link to it from any external doc, email, or external chat.
- ❌ Never include it as a "backup link" in case the dashboard link breaks — it will always break externally.

### ALWAYS link a Okidoki web URL — never the authenticated API URL — when referencing media externally

For a visual, use its printed \`Forge link\`: it opens a dedicated page, where signed-in organization members go straight to it and signed-out members sign in first. For other authenticated media references, use the dashboard form:

\`\`\`
https://app.okidoki.dev/workspaces/<workspace-id>?mode=media&media=<media-id>
\`\`\`

The \`mode=media&media=<media-id>\` query params open that specific file in the workspace.

When you have a specific file in mind, never link the bare workspace URL without the \`media=<id>\` param.

Always render it as a hyperlink labeled **View in Okidoki** (a URL button on Slack) — never paste a raw URL.

## In your Okidoki chat reply

Include each markdown embed line **verbatim** where you want that file to render inline. The chat substitutes each one with an embedded image, video, or audio player. Multiple embeds can appear in a single reply.

Never reply with only dashboard links (for example a "Links:" list of \`?mode=media&media=\` URLs) in place of the embeds: a dashboard link renders as plain text, so the user sees nothing inline. This applies even when the task came from Slack, Linear, GitHub, or GitLab; the chat reply still gets the embeds.

## On external platforms: embed the file AND link the dashboard

After \`okidoki media upload\` succeeds, external delivery has two required follow-up steps for every file:

1. **Use the destination's inline representation:** upload the raw bytes to Slack, Linear, or GitLab; embed the image's printed public link on GitHub.
2. **On Slack and Linear, link the Okidoki dashboard deep link** (\`?mode=media&media=<id>\` form) so the user can jump straight to the file in the workspace. On GitHub and GitLab, the embed is enough.

A dashboard link alone is never enough.

Slack, Linear, and GitLab receive the original bytes through their native upload APIs. GitHub uses the printed public link for screenshots and recording previews.

### Slack — embed natively via the 3-step external file upload flow

A Slack message that just contains a \`okidoki.dev\` link is not acceptable when the message is supposed to show an image. The recipient should see the image inline in the thread.

Slack deprecated the single-shot \`files.upload\` endpoint. The raw HTTP replacement is a 3-step flow: reserve an upload URL with \`files.getUploadURLExternal\`, POST the bytes to it, then share into the channel/thread with \`files.completeUploadExternal\`. (\`files.uploadV2\` is **only** an SDK convenience wrapper — it is NOT a real Web API HTTP endpoint and \`POST https://slack.com/api/files.uploadV2\` will return \`unknown_method\`.)

\`\`\`ts
import { okidoki } from '@okidoki/sdk';

const file = Bun.file('/abs/path/to/screenshot.png');
const reservation = await okidoki.slack.call<{ upload_url: string; file_id: string }>(
  'files.getUploadURLExternal', { filename: 'screenshot.png', length: file.size },
);
const uploaded = await fetch(reservation.upload_url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: file,
});
if (!uploaded.ok) throw new Error('Slack file upload failed');
await okidoki.slack.call('files.completeUploadExternal', {
  files: [{ id: reservation.file_id, title: 'Screenshot' }],
  channel_id: 'CHANNEL_ID',
  thread_ts: 'THREAD_TS',
  blocks: [{
    type: 'actions',
    elements: [{
      type: 'button',
      text: { type: 'plain_text', text: 'View in Okidoki' },
      url: 'https://app.okidoki.dev/workspaces/<workspace-id>?mode=media&media=<media-id>',
      action_id: 'view_media',
    }],
  }],
});
\`\`\`

Notes:
- All three steps are required; do not try to POST to \`https://slack.com/api/files.uploadV2\` — that endpoint does not exist on the Web API.
- The **View in Okidoki** link goes in a button, never as text. Leave out \`initial_comment\`: Slack ignores \`blocks\` when it is set.
- Omit \`thread_ts\` only when you genuinely want a top-level channel post.
- For multiple files in the same message, run steps 1–2 per file and pass all \`{id, title}\` objects in the \`files\` array of a single \`files.completeUploadExternal\` call — they share into the thread together.
- If you also need to post a separate text reply in the thread, send it with \`chat.postMessage\` after the upload — but the upload itself must carry the image.

Never paste the \`api.okidoki.dev/v1/media/<id>\` URL into a Slack message body or \`initial_comment\` — it will render as a broken image attempt.

### Linear — embed natively via the GraphQL \`fileUpload\` mutation

Linear comments and issue bodies support markdown image embeds, but the image URL must be publicly accessible — so you upload the file to Linear's storage first, then reference the returned \`assetUrl\` in markdown. Three steps:

Use \`jq\` to build the JSON bodies — the GraphQL variables (\`size\`, \`filename\`, the comment body) need to be real JSON values, not unquoted placeholders, and \`jq -n --argjson / --arg\` is the safest way to interpolate shell values without quoting bugs.

\`\`\`bash
FILE=/abs/path/to/screenshot.png
FILENAME=$(basename "$FILE")
SIZE=$(stat -c%s "$FILE" 2>/dev/null || stat -f%z "$FILE")
CONTENT_TYPE=image/png   # the file's real MIME type, e.g. video/mp4 for a recording
ISSUE_UUID=...           # the Linear issue's UUID
MEDIA_ID=...             # the media ID printed by \`okidoki media upload\`

linear_graphql() {
  curl -sS -X POST "$OKIDOKI_MONOLITH_URL/v1/engine/linear/graphql" \\
    -H "Authorization: Bearer $OKIDOKI_ENGINE_SECRET" \\
    -H "X-Workspace-Id: $OKIDOKI_WORKSPACE_ID" \\
    -H "Content-Type: application/json" \\
    --data-binary @-
}

# 1. Ask Linear for an upload URL + assetUrl.
RESERVE=$(jq -n \\
    --argjson size "$SIZE" \\
    --arg contentType "$CONTENT_TYPE" \\
    --arg filename "$FILENAME" \\
    '{
      query: "mutation($size: Int!, $contentType: String!, $filename: String!) { fileUpload(size: $size, contentType: $contentType, filename: $filename) { uploadFile { uploadUrl assetUrl headers { key value } } } }",
      variables: { size: $size, contentType: $contentType, filename: $filename }
    }' | linear_graphql)
UPLOAD_URL=$(echo "$RESERVE" | jq -r '.data.fileUpload.uploadFile.uploadUrl')
ASSET_URL=$(echo "$RESERVE" | jq -r '.data.fileUpload.uploadFile.assetUrl')

# 2. PUT the bytes to uploadUrl, replaying every header Linear returned.
#    Linear's presigned URL requires the exact Content-Type / Cache-Control /
#    etc. it gave you back, so forward each {key, value} from the headers array.
HEADER_ARGS=()
while IFS=$'\\t' read -r k v; do
  HEADER_ARGS+=(-H "$k: $v")
done < <(echo "$RESERVE" | jq -r '.data.fileUpload.uploadFile.headers[] | "\\(.key)\\t\\(.value)"')

curl -s -X PUT "$UPLOAD_URL" \\
  "\${HEADER_ARGS[@]}" \\
  --data-binary @"$FILE"

# 3. Reference assetUrl inline in the comment body, alongside the dashboard link.
BODY=$(printf '![screenshot](%s)\\n\\n[View in Okidoki](https://app.okidoki.dev/workspaces/%s?mode=media&media=%s)' \\
  "$ASSET_URL" "$OKIDOKI_WORKSPACE_ID" "$MEDIA_ID")

jq -n \\
    --arg issueId "$ISSUE_UUID" \\
    --arg body "$BODY" \\
    '{
      query: "mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }",
      variables: { issueId: $issueId, body: $body }
    }' | linear_graphql
\`\`\`

To show motion, upload the GIF from \`okidoki media gif\` this way as \`image/gif\` and embed its \`assetUrl\` like a screenshot. For a full recording, upload the MP4 with its own MIME type, then upload a poster frame (\`ffmpeg -i /tmp/demo.mp4 -frames:v 1 /tmp/demo-poster.png\`) the same way as \`image/png\` and link it: \`[![Demo recording](<poster-asset-url>)](<recording-asset-url>)\`.

The same flow works for issue bodies (use \`issueCreate\` / \`issueUpdate\` with the same markdown body).

Never paste the \`api.okidoki.dev/v1/media/<id>\` URL into a Linear body or comment — it will render as a broken image to anyone outside your Okidoki chat.

### GitHub: inline images and recording previews

Attach images with \`gh --attach\`, in public and private repositories alike. GitHub's own attachment upload rejects the workspace's GitHub App token, so in Okidoki workspaces \`gh\` uploads each image with \`okidoki media upload\` and puts its public link in the body instead. It prints each image's \`![…](…)\` line, so paste those in your chat reply too:

\`\`\`bash
gh pr create --title "Describe the change" --body-file /tmp/pr-body.md --attach './after.png#Settings page after the fix'
gh pr edit 456 --attach ./before.png --attach ./after.png
gh pr comment 456 --body-file /tmp/comment.md --attach ./after.png
\`\`\`

\`gh issue create|edit|comment\` take \`--attach\` too. Alt text follows \`#\`. A reference to the file in the body, such as \`![Before](./before.png)\`, is replaced with the image; other images are appended. Without a body flag, \`gh pr edit\` appends to the current description. \`--attach\` takes png, jpg, gif and webp only, and needs \`--body\` or \`--body-file\` rather than \`--fill\` or \`--template\`.

When you already uploaded an image, paste its printed \`![…](<public-url>)\` line into the body instead. Never use a local file path, a \`/v1/media/<id>\` URL, a Linear \`assetUrl\`, or an expiring storage URL.

GitHub does not play external videos inline, so show motion with a GIF (see *Make a GIF from a recording* above); its printed embed animates inline like any image. Videos stay private. When the full recording is also worth watching, upload the MP4 too and paste the PR line it prints, with your GIF's link filled in. The GIF links to the recording's **View in Okidoki** URL, or to its public link when you passed \`--access public\`. When a still is enough, use a poster instead (\`ffmpeg -i /tmp/demo.mp4 -frames:v 1 /tmp/demo-poster.png\`), uploaded like any image:

\`\`\`markdown
[![Checkout flow](<public-gif-or-poster-url>)](<recording-dashboard-url>)
\`\`\`

Public links are unauthenticated bearer capabilities. Revoke with \`okidoki media revoke <media-id>\` **only** when the user asks or the media should intentionally stop rendering; never as routine post-task cleanup, since revoking breaks every embed already posted on the PR.

For a self-contained HTML report, publish it with \`okidoki visualize\` and put the printed \`Forge link\` Markdown in the PR body or comment. GitHub cannot render the page inline, so use the normal link rather than image syntax. Visuals cannot be shared publicly.

Do **not** commit screenshots to the repo, use placeholder URLs, expose the authenticated \`/v1/media/<id>\` URL, or automate GitHub's undocumented browser upload flow.

### GitLab: native inline screenshots and videos

GitLab supports native project Markdown uploads. For a GitLab destination, always upload the media to Okidoki first, then POST the same original file to the repository's \`/projects/:id/uploads\` API using the workspace GitLab credential. Insert the returned \`markdown\` value into the merge request body or comment. Image uploads render inline; MP4, MOV, and WebM uploads render as inline video players.

Do not use a Okidoki public link for GitLab when the native project upload succeeds; native uploads preserve project access controls. \`okidoki.gitlab.request\` only sends JSON and cannot POST multipart file bytes, so without another supported upload path use the GitHub flow above instead: the image's printed public embed, and a poster linked to the recording's **View in Okidoki** URL.

## Recording defaults

When you record video (browser automation, screen capture, etc.):

- **Aspect ratio:** 16:9 (1920×1080 or 1280×720)
- **Frame rate:** 60 FPS or whatever the user specifies

Tools like Playwright default to a low frame rate that produces choppy playback — explicitly configure recording dimensions and FPS:

\`\`\`ts
const context = await browser.newContext({
  recordVideo: { dir: './videos', size: { width: 1280, height: 720 } },
});
\`\`\`

For \`ffmpeg\` screen captures, pass \`-r 30\` (or \`-r 60\`) to set the frame rate.

Start recording just before the interaction and stop right after it, so the GIF made from it stays short.

## Supported formats

Auto-detected from the filename extension:

| Extension | Kind |
|---|---|
| \`png\`, \`jpg\`, \`jpeg\`, \`webp\`, \`gif\` | image |
| \`mp4\`, \`webm\` | video |
| \`mp3\`, \`wav\` | audio |

For other extensions, pass \`--kind image|video|audio\` explicitly. The kind applies to every file in that invocation, so group files of the same kind together:

\`\`\`bash
okidoki media upload diagram.svg --name "Architecture diagram" --kind image
okidoki media upload chart-a.svg chart-b.svg --name "Latency chart" --name "Error rate chart" --kind image
\`\`\`

## Options

- \`--kind <image|video|audio>\` — override auto-detection
- \`--name <name>\`: required display name shown in the dashboard, one per file in order
- \`--session-id <id>\` — associate the upload with a specific session
- \`--access organization|public\`: for video and audio, print an organization-only link or create a public bearer URL. Images are always public
- \`--share\`: alias for \`--access public\`
`;

export const MEDIA_ABILITY: OkidokiAgentAbilityDescriptor = {
  label: 'Media',
  description: 'Deliver media to Okidoki and destination workflows with inline uploads.',
  bullet:
    '- Producing or showing the user any media — screenshots, screen recordings, generated images or diagrams, or audio clips — including in your Okidoki chat reply, PR descriptions/comments, and other external platforms. Paste the printed `![…](…)` embeds in your chat reply, never only dashboard links, and upload the file itself to Slack, Linear, or GitLab. To show motion, turn the recording into a short GIF with `okidoki media gif` instead of a grid of frames',
  section: SECTION,
  referenceFile: { name: 'MEDIA.md', content: REFERENCE },
};
