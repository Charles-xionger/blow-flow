/** Transport phases contain no model reasoning or user content. */
export type TextStreamPhase = 'connecting' | 'waiting' | 'thinking' | 'writing';
export class TextStreamError extends Error {}
