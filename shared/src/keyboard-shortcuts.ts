export const KEYBOARD_SHORTCUT_GROUPS = ['General', 'Navigation', 'Chat', 'Composer', 'Canvas', 'Media viewer', 'Review', 'Issues'] as const;

export type KeyboardShortcutGroup = typeof KEYBOARD_SHORTCUT_GROUPS[number];

export interface KeyboardShortcutKeys {
  key: string;
  mod?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

type KeyboardShortcutBindings =
  | { keys: KeyboardShortcutKeys; desktopKeys?: KeyboardShortcutKeys }
  | { keys?: undefined; desktopKeys: KeyboardShortcutKeys };

export type KeyboardShortcutDefinition = KeyboardShortcutBindings & {
  macKeys?: KeyboardShortcutKeys;
  linuxKeys?: KeyboardShortcutKeys;
  label: string;
  group: KeyboardShortcutGroup;
  allowInDialog?: boolean;
  /** A bare key pressed first, Graphite style: `{ prefix: 'g', keys: { key: 'i' } }` is G then I. */
  prefix?: string;
  ignoreWhileTyping?: boolean;
  /** Handled by the composer or the desktop menu rather than matched from this list, so it can't be remapped. */
  fixed?: boolean;
};

export const KEYBOARD_SHORTCUTS = {
  search: { label: 'Search', group: 'General', keys: { key: 'k', mod: true } },
  newWorkspace: {
    label: 'New workspace',
    group: 'General',
    keys: { key: 'o', mod: true, shift: true },
    desktopKeys: { key: 'n', mod: true },
  },
  toggleSidebar: { label: 'Toggle sidebar', group: 'General', keys: { key: 'b', mod: true } },
  toggleRightPane: { label: 'Toggle right pane', group: 'General', keys: { key: 'b', mod: true, alt: true } },
  openSettings: { label: 'Settings', group: 'General', keys: { key: ',', mod: true } },
  showKeyboardShortcuts: {
    label: 'Keyboard shortcuts',
    group: 'General',
    keys: { key: '/', mod: true },
    allowInDialog: true,
  },
  saveFile: { label: 'Save the open file', group: 'General', keys: { key: 's', mod: true } },
  closeWindow: { label: 'Close window', group: 'General', desktopKeys: { key: 'w', mod: true, shift: true }, fixed: true },
  previousWorkspace: {
    label: 'Previous workspace',
    group: 'Navigation',
    keys: { key: 'ArrowUp', alt: true },
    macKeys: { key: 'ArrowUp', mod: true, alt: true },
  },
  nextWorkspace: {
    label: 'Next workspace',
    group: 'Navigation',
    keys: { key: 'ArrowDown', alt: true },
    macKeys: { key: 'ArrowDown', mod: true, alt: true },
  },
  nextWorkspaceNeedingYou: {
    label: 'Next workspace that needs you',
    group: 'Navigation',
    keys: { key: 'ArrowDown', mod: true, alt: true, shift: true },
    linuxKeys: { key: 'ArrowDown', alt: true, shift: true },
  },
  jumpToWorkspace: { label: 'Workspace 1–9 in the sidebar', group: 'Navigation', desktopKeys: { key: '1', mod: true }, fixed: true },
  goBack: { label: 'Back', group: 'Navigation', desktopKeys: { key: '[', mod: true }, fixed: true },
  goForward: { label: 'Forward', group: 'Navigation', desktopKeys: { key: ']', mod: true }, fixed: true },
  stopAgent: { label: 'Stop the agent', group: 'Chat', keys: { key: 'Escape' } },
  newChat: { label: 'New chat', group: 'Chat', desktopKeys: { key: 't', mod: true } },
  previousChat: {
    label: 'Previous chat',
    group: 'Chat',
    keys: { key: '[', alt: true },
    macKeys: { key: '[', mod: true, alt: true },
    desktopKeys: { key: 'Tab', ctrl: true, shift: true },
  },
  nextChat: {
    label: 'Next chat',
    group: 'Chat',
    keys: { key: ']', alt: true },
    macKeys: { key: ']', mod: true, alt: true },
    desktopKeys: { key: 'Tab', ctrl: true },
  },
  closeTab: { label: 'Close tab', group: 'Chat', desktopKeys: { key: 'w', mod: true }, fixed: true },
  findInChat: { label: 'Find in chat', group: 'Chat', desktopKeys: { key: 'f', mod: true } },
  findInCanvas: { label: 'Find in canvas', group: 'Chat', desktopKeys: { key: 'f', mod: true } },
  shareWorkspace: { label: 'Share workspace', group: 'Chat', keys: { key: 's', mod: true, shift: true } },
  copyWorkspaceLink: { label: 'Copy workspace link', group: 'Chat', desktopKeys: { key: 'c', mod: true, shift: true } },
  archiveWorkspace: { label: 'Archive workspace', group: 'Chat', keys: { key: 'e', mod: true, shift: true } },
  // Cursor's binding. Claimed only while the Add to chat toolbar is showing, so the browser keeps it otherwise.
  addToChat: { label: 'Add selection to chat', group: 'Chat', keys: { key: 'l', mod: true } },
  // Zed's agent panel bindings (ToggleModelSelector, CycleFavoriteModels); Cursor also uses ⌥⌘/ on macOS.
  openModelPicker: {
    label: 'Choose model',
    group: 'Chat',
    keys: { key: '/', alt: true, shift: true },
    macKeys: { key: '/', mod: true, alt: true },
    linuxKeys: { key: '/', mod: true, alt: true },
  },
  nextModel: {
    label: 'Next model',
    group: 'Chat',
    keys: { key: 'l', alt: true },
    macKeys: { key: 'Tab', alt: true },
  },
  send: { label: 'Send', group: 'Composer', keys: { key: 'Enter' }, fixed: true },
  sendAlternate: { label: 'Queue or steer instead', group: 'Composer', keys: { key: 'Enter', alt: true }, fixed: true },
  newLine: { label: 'New line', group: 'Composer', keys: { key: 'Enter', shift: true }, fixed: true },
  toggleVoiceInput: { label: 'Voice input', group: 'Composer', keys: { key: ' ', mod: true, shift: true } },
  previousPrompt: { label: 'Previous prompt', group: 'Composer', keys: { key: 'ArrowUp' }, fixed: true },
  searchPromptHistory: { label: 'Search prompt history', group: 'Composer', keys: { key: 'r', ctrl: true } },
  mentionFile: { label: 'Mention a file', group: 'Composer', keys: { key: '@' }, fixed: true },
  slashCommand: { label: 'Commands and skills', group: 'Composer', keys: { key: '/' }, fixed: true },
  previousCanvasItem: { label: 'Previous item', group: 'Canvas', keys: { key: 'ArrowLeft' } },
  nextCanvasItem: { label: 'Next item', group: 'Canvas', keys: { key: 'ArrowRight' } },
  exitCanvasFullScreen: { label: 'Exit full screen', group: 'Canvas', keys: { key: 'Escape' } },
  previousMedia: { label: 'Previous', group: 'Media viewer', keys: { key: 'ArrowLeft' } },
  nextMedia: { label: 'Next', group: 'Media viewer', keys: { key: 'ArrowRight' } },
  zoomInMedia: { label: 'Zoom in', group: 'Media viewer', keys: { key: '+' } },
  zoomOutMedia: { label: 'Zoom out', group: 'Media viewer', keys: { key: '-' } },
  fitMediaToScreen: { label: 'Fit to screen', group: 'Media viewer', keys: { key: '0' } },
  toggleMediaPlayback: { label: 'Play or pause', group: 'Media viewer', keys: { key: ' ' } },
  toggleMediaText: { label: 'Show text', group: 'Media viewer', keys: { key: 't' } },
  showReviewShortcuts: { label: 'Show help', group: 'Review', keys: { key: '?' }, allowInDialog: true },
  toggleReviewSidebar: { label: 'Toggle left sidebar', group: 'Review', keys: { key: '[' } },
  toggleReviewSidePanel: { label: 'Show or hide chat', group: 'Review', keys: { key: ']' } },
  goToReviewInbox: { label: 'Go to review inbox', group: 'Review', prefix: 'g', keys: { key: 'i' } },
  showReviewShortcutsSequence: { label: 'Show keyboard shortcut help', group: 'Review', prefix: 'g', keys: { key: 'k' } },
  toggleReviewFileTree: { label: 'Show or hide file tree', group: 'Review', keys: { key: 'f' } },
  toggleReviewMode: { label: 'Switch Files / Tour', group: 'Review', keys: { key: 't' } },
  showReviewDiscussion: { label: 'Jump to comments', group: 'Review', keys: { key: '2' } },
  showReviewCommits: { label: 'Jump to commits', group: 'Review', keys: { key: '3' } },
  toggleReviewComments: { label: 'Show or hide comments', group: 'Review', keys: { key: 'i' } },
  approvePullRequest: { label: 'Approve', group: 'Review', prefix: 'r', keys: { key: 'y' } },
  nextReviewFile: { label: 'Next file', group: 'Review', keys: { key: 'ArrowDown', mod: true } },
  previousReviewFile: { label: 'Previous file', group: 'Review', keys: { key: 'ArrowUp', mod: true } },
  markReviewFileViewed: { label: 'Mark file as viewed', group: 'Review', keys: { key: 'Enter', mod: true }, ignoreWhileTyping: true },
  nextReviewComment: { label: 'Next thread', group: 'Review', keys: { key: 'ArrowDown', shift: true } },
  previousReviewComment: { label: 'Previous thread', group: 'Review', keys: { key: 'ArrowUp', shift: true } },
  nextPullRequest: { label: 'Next pull request to review', group: 'Review', keys: { key: 'ArrowDown', mod: true, shift: true } },
  previousPullRequest: { label: 'Previous pull request to review', group: 'Review', keys: { key: 'ArrowUp', mod: true, shift: true } },
  copyReviewLink: { label: 'Copy link', group: 'Review', prefix: 'c', keys: { key: 'l' } },
  copyPullRequestNumber: { label: 'Copy PR number', group: 'Review', prefix: 'c', keys: { key: 'n' } },
  copyPullRequestTitle: { label: 'Copy title', group: 'Review', prefix: 'c', keys: { key: 't' } },
  copyPullRequestBranch: { label: 'Copy branch name', group: 'Review', prefix: 'c', keys: { key: 'b' } },
  copyPullRequestCheckout: { label: 'Copy checkout command', group: 'Review', prefix: 'c', keys: { key: 'c' } },
  copyPullRequestGitHubLink: { label: 'Copy GitHub link', group: 'Review', prefix: 'c', keys: { key: 'g' } },
  copyPullRequest: { label: 'Copy PR', group: 'Review', prefix: 'c', keys: { key: 'p' } },
  openReviewChat: { label: 'Start chat', group: 'Review', keys: { key: ';', mod: true } },
  mergePullRequest: { label: 'Merge', group: 'Review', keys: { key: 'm' } },
  createIssue: { label: 'Create issue', group: 'Issues', keys: { key: 'c' } },
  searchIssues: { label: 'Search issues', group: 'Issues', keys: { key: '/' } },
  setIssueStatus: { label: 'Change status', group: 'Issues', keys: { key: 's' } },
  setIssuePriority: { label: 'Change priority', group: 'Issues', keys: { key: 'p' } },
  setIssueAssignees: { label: 'Assign', group: 'Issues', keys: { key: 'a' } },
  nextIssue: { label: 'Next issue', group: 'Issues', keys: { key: 'j' } },
  previousIssue: { label: 'Previous issue', group: 'Issues', keys: { key: 'k' } },
  openIssue: { label: 'Open issue', group: 'Issues', keys: { key: 'Enter' } },
  peekIssue: { label: 'Peek issue', group: 'Issues', keys: { key: ' ' } },
  selectIssue: { label: 'Select issue', group: 'Issues', keys: { key: 'x' } },
  toggleIssueLayout: { label: 'Switch list / board', group: 'Issues', keys: { key: 'b', mod: true, shift: true } },
  copyIssueIdentifier: { label: 'Copy issue ID', group: 'Issues', keys: { key: '.', mod: true } },
  copyIssueLink: { label: 'Copy issue link', group: 'Issues', keys: { key: ',', mod: true, shift: true } },
} as const satisfies Record<string, KeyboardShortcutDefinition>;

export type KeyboardShortcutId = keyof typeof KEYBOARD_SHORTCUTS;

export const isKeyboardShortcutId = (id: string): id is KeyboardShortcutId => Object.hasOwn(KEYBOARD_SHORTCUTS, id);

export type KeyboardShortcutOverrides = Partial<Record<KeyboardShortcutId, KeyboardShortcutKeys>>;

export const isCustomizableShortcut = (shortcut: KeyboardShortcutDefinition) => !shortcut.fixed && !shortcut.prefix;

const RESERVED_MOD_KEYS = new Set(['q', 'w', 'c', 'v', 'x', 'a', 'z', 'y', 'r', 'h', 'm']);
const RESERVED_MOD_SHIFT_KEYS = new Set(['q', 'z', 'r']);

/** OS and editing chords (quit, close, copy, paste, undo, reload, switch app) that a remap would take away. */
export function isReservedShortcutKeys(keys: KeyboardShortcutKeys): boolean {
  if ((keys.mod || keys.ctrl) && !keys.alt && (keys.shift ? RESERVED_MOD_SHIFT_KEYS : RESERVED_MOD_KEYS).has(keys.key)) return true;
  if (keys.alt && (keys.key === 'F4' || keys.key === 'Tab')) return true;
  return keys.key === 'Tab' && !keys.mod && !keys.ctrl && !keys.alt && !keys.shift;
}

export const SEND_KEYS = ['enter', 'mod_enter'] as const;
export type SendKey = typeof SEND_KEYS[number];

export const COMPOSER_SEND_SHORTCUTS = {
  enter: { send: KEYBOARD_SHORTCUTS.send, sendAlternate: KEYBOARD_SHORTCUTS.sendAlternate, newLine: KEYBOARD_SHORTCUTS.newLine },
  mod_enter: {
    send: { ...KEYBOARD_SHORTCUTS.send, keys: { key: 'Enter', mod: true } },
    sendAlternate: { ...KEYBOARD_SHORTCUTS.sendAlternate, keys: { key: 'Enter', mod: true, alt: true } },
    newLine: { ...KEYBOARD_SHORTCUTS.newLine, keys: { key: 'Enter' } },
  },
} satisfies Record<SendKey, Record<'send' | 'sendAlternate' | 'newLine', KeyboardShortcutDefinition>>;

const MAC_KEY_LABELS: Record<string, string> = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: '↵', Escape: 'Esc', Tab: '⇥', ' ': 'Space',
  Backspace: '⌫', Shift: '⇧', Alt: '⌥', Mod: '⌘',
};
const OTHER_KEY_LABELS: Record<string, string> = { ...MAC_KEY_LABELS, Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Shift: 'Shift', Alt: 'Alt', Mod: 'Ctrl' };

export function getKeyLabels(keys: KeyboardShortcutKeys, platform: { mac: boolean }): string[] {
  const key = (platform.mac ? MAC_KEY_LABELS : OTHER_KEY_LABELS)[keys.key] ?? (keys.key.length === 1 ? keys.key.toUpperCase() : keys.key);
  const modifiers = platform.mac
    ? [keys.ctrl && '⌃', keys.alt && '⌥', keys.shift && '⇧', keys.mod && '⌘']
    : [(keys.mod || keys.ctrl) && 'Ctrl', keys.alt && 'Alt', keys.shift && 'Shift'];
  return [...modifiers.filter((modifier): modifier is string => Boolean(modifier)), key];
}

export const cycleIndex = (current: number, by: 1 | -1, length: number) =>
  current < 0 ? (by > 0 ? 0 : length - 1) : (current + by + length) % length;
