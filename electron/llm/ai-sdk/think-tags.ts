/**
 * Reasoning-text conventions shared by the AI SDK transport. Providers report
 * hidden reasoning either as separate stream events (mapped to <think> markers
 * here) or inline in visible content (stripped here); the committed contract is
 * that onDone/onGenerate text never contains reasoning.
 */
export function stripThinkingTags(content: string): string {
  return content
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(/^[\s\S]*?<\/think>\s*/i, '')
    .replace(/<\/?think>/gi, '')
    .trim()
}

export const THINK_OPEN_MARKER = '<think>\n'
export const THINK_CLOSE_MARKER = '\n</think>\n\n'
