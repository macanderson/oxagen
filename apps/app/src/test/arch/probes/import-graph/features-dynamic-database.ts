export async function read(): Promise<unknown> {
  const { db } = await import("@oxagen/database");
  return db;
}
