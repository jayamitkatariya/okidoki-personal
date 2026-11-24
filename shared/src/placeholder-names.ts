const FRUITS = [
  'apple', 'banana', 'cherry', 'fig', 'grape', 'kiwi', 'lemon', 'lime',
  'mango', 'melon', 'olive', 'orange', 'peach', 'pear', 'plum', 'guava',
  'papaya', 'lychee', 'coconut', 'apricot', 'avocado', 'berry',
  'kumquat', 'nectarine', 'tangerine',
  'dragonfruit',
] as const;

const TTC_STATIONS = [
  'kipling', 'islington', 'royal-york', 'old-mill', 'jane', 'runnymede',
  'high-park', 'keele', 'dundas-west', 'lansdowne', 'dufferin', 'ossington',
  'christie', 'bathurst', 'spadina', 'st-george', 'bay', 'bloor-yonge',
  'sherbourne', 'castle-frank', 'broadview', 'chester', 'pape', 'donlands',
  'greenwood', 'woodbine', 'warden', 'kennedy',
] as const;

function randomElement<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generatePlaceholderName(): string {
  return `${randomElement(FRUITS)}-${randomElement(TTC_STATIONS)}`;
}

const MAX_WORKSPACE_NAME_LENGTH = 48;

export function normalizeWorkspaceName(value: string, maxLength = MAX_WORKSPACE_NAME_LENGTH): string {
  const name = value.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim();
  return name.length > maxLength
    ? name.slice(0, maxLength + 1).replace(/\s+\S*$/, '').slice(0, maxLength).replace(/[\s-]+$/, '')
    : name;
}

export function workspaceNameFromPrompt(prompt: string): string {
  // Mentions are markdown links, so the name keeps their label (`@Riley`) instead of the URL.
  const line = normalizeWorkspaceName(prompt.trim().split('\n', 1)[0].replace(/\[((?:[^\]\\\n]|\\.)+)\]\([^\s)]+\)/g, (_link, label: string) => label.replace(/\\(.)/g, '$1')), Infinity);
  return line.length > MAX_WORKSPACE_NAME_LENGTH
    ? `${normalizeWorkspaceName(line, MAX_WORKSPACE_NAME_LENGTH - 1).replace(/[.,;:!?]+$/, '')}…`
    : line;
}

export { FRUITS, TTC_STATIONS };
