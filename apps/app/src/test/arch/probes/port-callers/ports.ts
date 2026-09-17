export interface DataSource {
  runs: {
    list(ctx: unknown): Promise<unknown>;
    get(ctx: unknown, runId: string): Promise<unknown>;
  };
  shell: { context(ctx: unknown): Promise<unknown> };
}
