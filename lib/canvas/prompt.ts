/** Saved form of a prompt (ADR 0005). `ref` is the upstream node ID. Knows nothing about the editor. */
export type Segment = { text: string } | { ref: string };
export type Prompt = string | Segment[];

export function promptSegments(prompt: Prompt | undefined): Segment[] {
  if (Array.isArray(prompt)) return prompt;
  return prompt ? [{ text: prompt }] : [];
}

/** The text sent to a model. */
export function promptText(prompt: Prompt | undefined): string {
  return promptSegments(prompt).map(segment => 'text' in segment ? segment.text : '').join('');
}

/** A prompt that expands to nothing but whitespace cannot run. */
export function promptIsEmpty(prompt: Prompt | undefined): boolean {
  return !promptText(prompt).trim();
}
