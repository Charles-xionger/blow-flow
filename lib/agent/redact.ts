const secretName = String.raw`(?:x-goog-api-key|x-api-key|api[_-]?key|access[_-]?token|token|key|authorization)`;
/** Operator-facing form of a failure (logs, traces): provider text kept, credentials masked. */
export function redactedFailure(error: unknown) {
    const text = error instanceof Error ? error.message : String(error);
    return text
        .replace(/AIza[0-9A-Za-z_-]{10,}/g, '<REDACTED>')
        .replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer <REDACTED>')
        .replace(new RegExp(String.raw`("${secretName}"\s*:\s*)"[^"]*"`, 'gi'), '$1"<REDACTED>"')
        .replace(new RegExp(String.raw`\b(${secretName}\s*[:=]\s*)(?!<REDACTED>|Bearer )[^&\s"',}]+`, 'gi'), '$1<REDACTED>');
}
