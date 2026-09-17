export async function decisions(): Promise<unknown> {
  const { captureError, chSelect } = await import("@oxagen/telemetry");
  return [captureError, chSelect];
}
