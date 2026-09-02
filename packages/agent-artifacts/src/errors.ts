/**
 * Every failure this package raises on its own. `code` is the stable
 * machine-readable half and is also prefixed onto `message`, so a caller can
 * branch on `error.code` while a log line still reads usefully on its own.
 */
export class AgentArtifactError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "AgentArtifactError";
    this.code = code;
  }
}
