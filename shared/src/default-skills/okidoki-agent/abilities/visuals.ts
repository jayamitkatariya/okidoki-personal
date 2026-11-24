import { VISUAL_PAGE_RULES } from '../../../visuals';
import type { OkidokiAgentAbilityDescriptor } from '../types';

const SECTION = `### Visuals
Show a chart, diagram, comparison, timeline, or mockup inline in your Okidoki chat reply, in the chat's own font and colors.

**Reference:** \`references/VISUALS.md\`

Use this when:
- Seeing it would explain faster than reading it: numbers over time, a flow or architecture, a before and after, options side by side
- The user asks to see, chart, plot, compare, or visualize something`;

const REFERENCE = `# Visuals

A visual is a self-contained HTML page shown inline in your Okidoki chat reply. It sits on the chat background in the chat's font and colors, grows to fit its content, and follows the user's light or dark theme live.

## When to make one

Make one when seeing beats reading: how parts of a system connect, how a request or data flows, numbers or options compared, a timeline, a before and after, or a UI mockup. Make one when the user asks to see, chart, compare, sketch, or visualize something. Never draw these as ASCII art or text diagrams.

Don't make one when:
- A short answer or list covers it.
- It is a plain table: write a Markdown table.
- It is screenshots, or a before and after of them: upload them as images, which readers can open full screen and zoom. See "Before and after" in \`references/MEDIA.md\`.
- The user wants a page, site, or component in their project: build that in the repo.

A long report or write-up goes in the Canvas, and its key charts and comparisons go in a visual in your reply. Never screenshot a report, chart, or diagram you made to show it: a long page shrunk to an image can't be read, and it ignores the reader's theme. Screenshots of app UI you changed are still right.

## Make it

1. Write the page, for example \`/tmp/visuals/<name>.html\`, following the page rules below.
2. Run \`okidoki visualize <page.html> --title "<short title>"\`. It checks the page in a headless browser, publishes it, and prints two screenshots (dark at desktop width, light at phone width) with any console errors and layout warnings.
3. Open both screenshots and look. If anything is wrong, fix the page and publish again, then use the newest line. While iterating, \`okidoki visualize <page.html> --check\` renders without publishing.
4. Paste the printed \`![…](…)\` line on its own line where the visual belongs in your final reply.

## Page rules

${VISUAL_PAGE_RULES}

## In your reply

- The user sees the visual itself. Don't introduce it ("Here's a chart", "Here's the diagram"), say where it is, or restate its data. Add only what it doesn't say, such as the takeaway or a caveat.
- Paste the line in your final reply, not in a progress update. To change a visual, edit the page, publish it again, and paste the new line.
- The line only renders in Okidoki chat. When you post to pull requests, Slack, Linear, or anywhere else, link the printed Forge link instead. Leave the Forge link out of your chat reply.
`;

export const VISUALS_ABILITY: OkidokiAgentAbilityDescriptor = {
  label: 'Visuals',
  description: 'Show charts, diagrams, comparisons, and mockups inline in chat replies.',
  // The visuals_instructions system prompt block is its trigger.
  bullet: '',
  section: SECTION,
  referenceFile: { name: 'VISUALS.md', content: REFERENCE },
};
