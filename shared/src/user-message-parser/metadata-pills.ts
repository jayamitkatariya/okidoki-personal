import { getProviderDisplayName } from '../agent';
import { formatManagerSubagentName, isManagerEventMessage, parseManagerEventMessage } from '../manager-events';
import { parseMessageOrigin } from '../message-origin';
import { stripOkidokiInstructionBlock } from '../prompts';
import { stripAttachmentNote, withoutAttachmentPlaceholder } from '../user-message-attachments';
import { parseUserMessage } from './parsers';
import type { ParsedPrompt, PromptSource } from './types';
import { SOURCE_CONFIG } from './source-config';

export interface MetadataPillData {
  label: string;
  value: string;
}

export interface ParsedMessageMetadata {
  sourceLabel: string;
  pills: MetadataPillData[];
  preview: string;
}

export interface UserMessagePreview {
  preview: string;
  source: Exclude<PromptSource, 'raw'> | null;
  pills: MetadataPillData[];
}

export function getUserMessagePreview(rawContent: string, emptyPreview = ''): UserMessagePreview {
  const stripped = stripAttachmentNote(stripOkidokiInstructionBlock(rawContent));
  const { files, walkthroughs, appshots, annotations } = stripped;
  const content = withoutAttachmentPlaceholder(stripped.content, files.length > 0);
  if (isManagerEventMessage(content)) {
    const events = parseManagerEventMessage(rawContent);
    return { preview: events?.every((event) => event.issue) ? `Issue update · ${events.map((event) => event.agentName).join(', ')}` : 'Ship update', source: null, pills: [] };
  }
  const origin = parseMessageOrigin(rawContent);
  if (origin) return { preview: origin.kind === 'board' ? origin.body : formatManagerSubagentName(origin.name), source: null, pills: [] };
  const parsed = parseUserMessage(content);
  const metadata = getSourceMetadataPills(parsed);

  return {
    preview: metadata.preview.trim()
      || content.trim()
      || files.map((file) => file.slice(file.lastIndexOf('/') + 1)).join(', ')
      || (walkthroughs.length > 0 ? 'Walkthrough' : '')
      || annotations.map((annotation) => annotation.comment ?? annotation.text).join(', ')
      || appshots.map(({ appName }) => `${appName} window`).join(', ')
      || emptyPreview,
    source: parsed.source === 'raw' ? null : parsed.source,
    pills: metadata.pills,
  };
}

export function getSourceMetadataPills(parsed: ParsedPrompt): ParsedMessageMetadata {
  if (parsed.source === 'raw') {
    return { sourceLabel: '', pills: [], preview: parsed.content };
  }

  const config = SOURCE_CONFIG[parsed.source];
  const pills: MetadataPillData[] = [];
  let preview = '';

  switch (parsed.source) {
    case 'ci_failure':
      pills.push(
        parsed.isMergeRequest
          ? { label: 'MR', value: `!${parsed.prNumber}` }
          : { label: 'PR', value: `#${parsed.prNumber}` }
      );
      pills.push({ label: 'Workflow', value: parsed.workflowName });
      preview = `Workflow ${parsed.workflowName} ${parsed.conclusionText} on ${parsed.isMergeRequest ? 'MR' : 'PR'} ${parsed.isMergeRequest ? '!' : '#'}${parsed.prNumber}`;
      break;
    case 'linear_issue':
      pills.push({ label: '', value: parsed.identifier });
      if (parsed.creatorName) pills.push({ label: 'From', value: `@${parsed.creatorName}` });
      preview = parsed.request || parsed.description || parsed.title;
      break;
    case 'github_issue_new':
      pills.push({ label: 'Issue', value: `#${parsed.issueNumber}` });
      if (parsed.triggeringUser) pills.push({ label: 'From', value: `@${parsed.triggeringUser}` });
      preview = parsed.triggeringComment || parsed.issueTitle;
      break;
    case 'github_issue_existing':
      pills.push({ label: 'Issue', value: `#${parsed.issueNumber}` });
      if (parsed.commentUser) pills.push({ label: 'From', value: `@${parsed.commentUser}` });
      preview = parsed.commentBody;
      break;
    case 'gitlab_issue_new':
      pills.push({ label: 'Issue', value: `#${parsed.issueNumber}` });
      if (parsed.triggeringUser) pills.push({ label: 'From', value: `@${parsed.triggeringUser}` });
      preview = parsed.triggeringComment || parsed.issueTitle;
      break;
    case 'gitlab_issue_existing':
      pills.push({ label: 'Issue', value: `#${parsed.issueNumber}` });
      if (parsed.commentUser) pills.push({ label: 'From', value: `@${parsed.commentUser}` });
      preview = parsed.commentBody;
      break;
    case 'github_pr_new':
      pills.push({ label: 'PR', value: `#${parsed.prNumber}` });
      if (parsed.mentioningUser) pills.push({ label: 'From', value: `@${parsed.mentioningUser}` });
      preview = parsed.contextMessage;
      break;
    case 'github_pr_existing_review':
      pills.push({ label: 'PR', value: `#${parsed.prNumber}` });
      if (parsed.commentUser) pills.push({ label: 'From', value: `@${parsed.commentUser}` });
      preview = parsed.commentBody;
      break;
    case 'github_pr_existing_pr_review':
      pills.push({ label: 'PR', value: `#${parsed.prNumber}` });
      if (parsed.reviewUser) pills.push({ label: 'From', value: `@${parsed.reviewUser}` });
      preview = parsed.commentBody || `@${parsed.reviewUser} ${parsed.reviewAction}`;
      break;
    case 'github_pr_existing_general':
      pills.push({ label: 'PR', value: `#${parsed.prNumber}` });
      if (parsed.commentUser) pills.push({ label: 'From', value: `@${parsed.commentUser}` });
      preview = parsed.commentBody;
      break;
    case 'gitlab_mr_existing_general':
      pills.push({ label: 'MR', value: `!${parsed.mergeRequestIid}` });
      if (parsed.commentUser) pills.push({ label: 'From', value: `@${parsed.commentUser}` });
      preview = parsed.commentBody;
      break;
    case 'slack_task':
      if (parsed.workspaceTarget) pills.push({ label: 'Target', value: parsed.workspaceTarget });
      if (parsed.latestMessageUser) pills.push({ label: 'From', value: `@${parsed.latestMessageUser}` });
      preview = parsed.latestMessageText;
      break;
    case 'text_message':
      if (parsed.sender) pills.push({ label: 'From', value: parsed.sender });
      preview = parsed.text;
      break;
    case 'automation_triggered':
      pills.push({ label: '', value: parsed.automationName });
      if (parsed.event) pills.push({ label: 'Event', value: parsed.event });
      preview = parsed.userPrompt;
      break;
    case 'plan_quote':
      if (parsed.blocks[0]) pills.push({ label: 'Plan', value: parsed.blocks[0].planFilename.replace(/\.md$/, '') });
      preview = parsed.blocks.map((block) => block.replyText || block.quotedText).find(Boolean) || parsed.leadingText;
      break;
    case 'inline_diff_comments': {
      const firstPlanBlock = parsed.leadingPlanQuote?.blocks[0];
      if (firstPlanBlock) {
        pills.push({ label: 'Plan', value: firstPlanBlock.planFilename.replace(/\.md$/, '') });
      }
      pills.push({ label: 'Comments', value: `${parsed.comments.length}` });
      const firstComment = parsed.comments[0];
      if (firstComment) {
        pills.push({ label: 'File', value: firstComment.location });
        preview = parsed.leadingPlanQuote?.leadingText || parsed.leadingText || firstComment.body;
      } else {
        preview = parsed.leadingText;
      }
      break;
    }
    case 'chat_fork':
      pills.push({ label: 'From', value: getProviderDisplayName(parsed.sourceProvider, 'long') });
      if (parsed.trigger === 'auto') pills.push({ label: '', value: parsed.reason === 'out_of_credits' ? 'Out of credits' : parsed.reason === 'auth_failed' ? 'Auth failed' : parsed.reason === 'credits_required' ? 'Needs usage credits' : parsed.reason === 'model_unavailable' ? 'Model unavailable' : 'Usage limit' });
      preview = parsed.replyText;
      break;
    case 'merged': {
      pills.push({ label: '', value: `${parsed.messages.length} messages` });
      // Show the kind of the first merged message so the user can see at
      // a glance what was bundled (most merge bursts are homogeneous).
      const first = parsed.messages[0];
      if (first && first.source !== 'raw') {
        const firstConfig = SOURCE_CONFIG[first.source];
        if (firstConfig) pills.push({ label: 'Kind', value: firstConfig.label });
      }
      preview = parsed.messages
        .map((message) => getSourceMetadataPills(message).preview)
        .filter(Boolean)
        .join('\n');
      break;
    }
  }

  return {
    sourceLabel: config.label,
    pills,
    preview,
  };
}
