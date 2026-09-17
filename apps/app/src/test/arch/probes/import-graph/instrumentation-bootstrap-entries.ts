export async function boot(): Promise<unknown> {
  const { initTracer } = await import("@oxagen/telemetry");
  const { recordSecurityEvent } = await import("@oxagen/telemetry");
  const { makeSecurityEventInserter } = await import(
    "@oxagen/database/security"
  );
  const { assertRlsConnectionSafe } = await import("@oxagen/database");
  return [
    initTracer,
    recordSecurityEvent,
    makeSecurityEventInserter,
    assertRlsConnectionSafe,
  ];
}
