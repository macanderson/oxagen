export class AgentArtifactError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "AgentArtifactError";
    this.code = code;
  }
}
