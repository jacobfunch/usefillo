/** Shared keyword ranking for the CLI and both MCP transports. Search never
 * changes which tools a caller is authorized to see. */
const TASK_WORDS = new Set([
  "a",
  "an",
  "the",
  "my",
  "our",
  "for",
  "to",
  "with",
  "of",
  "and",
  "can",
  "i",
  "me",
  "how",
  "do",
  "in",
  "on",
  "what",
  "which",
  "find",
  "diagnose",
  "show",
]);

function tokens(text) {
  return (text.toLowerCase().match(/[a-z0-9]+/gu) ?? []).map((word) => {
    if (["failed", "failure", "failures", "failing"].includes(word)) return "fail";
    if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
    return word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
  });
}

export function rankCapabilities(items, query, document, limit = 10) {
  const terms = [...new Set(tokens(query).filter((word) => !TASK_WORDS.has(word)))];
  return items
    .map((item, index) => {
      const text = document(item);
      const primary = new Set(tokens(`${text.name} ${text.title}`));
      const tags = new Set(tokens(text.tags?.join(" ") ?? ""));
      const details = new Set(tokens(text.description));
      const score = terms.reduce(
        (total, term) =>
          total + (primary.has(term) ? 10 : tags.has(term) ? 4 : details.has(term) ? 1 : 0),
        0,
      );
      return { item, index, score };
    })
    .filter((entry) => terms.length === 0 || entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.item);
}
