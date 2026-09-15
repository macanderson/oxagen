export async function connections() {
  const database = await import("@oxagen/database");
  return database.withSystemDb((tx) =>
    tx.select().from(database.schema.sourceConnections),
  );
}
