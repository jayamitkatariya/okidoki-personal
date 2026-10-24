// Command fields are argument lists, never evaluated as shell code.
export function joinCommand(words: string[]): string {
  return words.map(word => /^[A-Za-z0-9_./:@%+=,-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`).join(" ");
}

export function splitCommand(line: string): string[] | null {
  const words: string[] = [];
  let word = "", quote = "", started = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === "\\" && quote !== "'") {
      if (i + 1 === line.length) return null;
      const next = line[++i];
      word += quote === '"' && !['"', "\\", "$", "`", "\n"].includes(next) ? `\\${next}` : next === "\n" ? "" : next;
      started = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(word);
      word = ""; started = false;
    } else {
      word += char; started = true;
    }
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}
