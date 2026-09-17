type RunsPort = { list(ctx: unknown): Promise<unknown> };

export interface DataSource {
  runs: RunsPort;
}
