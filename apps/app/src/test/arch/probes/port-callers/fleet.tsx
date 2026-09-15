export async function Fleet({ source, ctx }: { source: never; ctx: never }) {
  await source.runs.list(ctx);
  return null;
}
