/**
 * Chat-style reply splitting for OneBot (QQ): each line becomes its own message, and a trailing
 * full stop is dropped, the way people type in QQ. Question and exclamation marks are kept.
 */

export interface SplitReplyOptions {
  /** Most messages one reply becomes; the rest is joined into the last one (default 4) */
  maxParts?: number
}

/** Trailing Chinese/ASCII full stops (but not an ellipsis) are removed from each message. */
export function dropTrailingPeriod(text: string): string {
  if (/(…|\.\.\.)$/.test(text)) return text
  return text.replace(/[。.]+$/u, '').trimEnd()
}

export function splitReply(text: string, opts: SplitReplyOptions = {}): string[] {
  const lines = text
    .split(/\n+/)
    .map((line) => dropTrailingPeriod(line.trim()))
    .filter((line) => line.length > 0)
  const max = Math.max(1, opts.maxParts ?? 4)
  if (lines.length <= max) return lines
  return [...lines.slice(0, max - 1), lines.slice(max - 1).join(' ')]
}
