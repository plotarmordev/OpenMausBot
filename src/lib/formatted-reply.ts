const TABLE_DIVIDER = /^ {0,3}\|? *:?-{3,}:? *\|/m;
const BLOCK_MARKDOWN = [
  /^ {0,3}(?:[-*+]|\d{1,3}[.)]) \S/m,
  /^ {0,3}#{1,6} \S/m,
  /^ {0,3}(?:```|~~~)/m,
  /^ {0,3}> ?\S/m,
  TABLE_DIVIDER,
];

/** A reply with block markdown (a list, heading, code, quote or table) reads as a document, not a chat line. */
export function isFormattedReply(text: string): boolean {
  return BLOCK_MARKDOWN.some((pattern) => pattern.test(text));
}

/** A formatted reply reads at prose width; one with a table takes the message's full width so every column shows,
 * and its prose stays at reading width (`.chat-wide` in styles.css). */
export function formattedReplyWidth(text: string): string {
  return TABLE_DIVIDER.test(text)
    ? "chat-wide w-full max-w-[var(--chat-card-pct)]"
    : "w-full max-w-[min(var(--chat-prose-max),var(--chat-card-pct))]";
}
