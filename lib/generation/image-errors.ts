/** Only application-authored messages can be shown to users; provider bodies may contain secrets. */
export class ImageGenerationError extends Error {
  constructor(message: string, readonly kind: 'preparation' | 'rejected') { super(message); }
}
