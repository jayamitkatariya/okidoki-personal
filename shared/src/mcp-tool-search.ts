export function rankToolsByQuery<T>(tools: readonly T[], query: string, text: (tool: T) => { name: string; description: string }): T[] {
  const terms = query.toLowerCase().split(/[\s_-]+/).filter(Boolean);
  return tools
    .map((tool) => {
      const { name, description } = text(tool);
      return { tool, score: terms.reduce((sum, term) => sum + (name.toLowerCase().includes(term) ? 3 : 0) + (description.toLowerCase().includes(term) ? 1 : 0), 0) };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ tool }) => tool);
}
