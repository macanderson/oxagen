export async function boot(): Promise<unknown> {
  const { assertRlsConnectionSafe, withSystemDb } = await import(
    "@oxagen/database"
  );
  return [assertRlsConnectionSafe, withSystemDb];
}
