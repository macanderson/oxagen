// Probe for unrecorded.test.ts: a port named for a page that is still an UNRECORDED row.
export interface DataSource {
  spend: { summary(): Promise<unknown> };
}
