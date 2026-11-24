export const EXT_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'tsx', '.mts': 'typescript', '.cts': 'typescript', '.js': 'javascript', '.jsx': 'jsx',
  '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.pyw': 'python', '.pyi': 'python',
  '.rs': 'rust', '.go': 'go', '.rb': 'ruby', '.rake': 'ruby',
  '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.scala': 'scala',
  '.swift': 'swift', '.m': 'objectivec', '.mm': 'objectivec',
  '.c': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp',
  '.h': 'c', '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp',
  '.cs': 'csharp', '.vb': 'vbnet', '.fs': 'fsharp',
  '.php': 'php', '.phtml': 'php',
  '.css': 'css', '.scss': 'scss', '.sass': 'sass', '.less': 'less',
  '.html': 'html', '.htm': 'html', '.vue': 'vue', '.svelte': 'svelte',
  '.xml': 'xml', '.svg': 'xml',
  '.json': 'json', '.json5': 'json5',
  '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.ini': 'ini',
  '.md': 'markdown', '.markdown': 'markdown',
  '.mmd': 'mermaid', '.mermaid': 'mermaid',
  '.sql': 'sql',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash', '.fish': 'bash',
  '.dockerfile': 'dockerfile',
  '.graphql': 'graphql', '.proto': 'protobuf',
  '.r': 'r', '.lua': 'lua', '.dart': 'dart', '.zig': 'zig',
  '.ex': 'elixir', '.exs': 'elixir', '.erl': 'erlang',
  '.hs': 'haskell', '.ml': 'ocaml',
  '.clj': 'clojure', '.cljs': 'clojure',
  '.pl': 'perl', '.perl': 'perl',
  '.elm': 'elm', '.lisp': 'lisp',
  '.tex': 'latex', '.sty': 'latex', '.bib': 'bibtex',
};

export function detectLanguageByPath(filePath: string): string | null {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) {
    const basename = filePath.split('/').pop() ?? '';
    if (basename === 'Dockerfile') return 'dockerfile';
    if (basename === 'Makefile') return 'makefile';
    return null;
  }
  const ext = filePath.slice(dot).toLowerCase();
  return EXT_TO_LANGUAGE[ext] ?? null;
}
