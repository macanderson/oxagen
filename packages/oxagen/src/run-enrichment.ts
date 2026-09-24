/** Only the AI-written run name and summary are controlled by this setting. */
export function runEnrichmentEnabled(settings: unknown): boolean {
  if (
    typeof settings !== "object" ||
    settings === null ||
    Array.isArray(settings)
  )
    return true;
  return (settings as Record<string, unknown>).runEnrichmentEnabled !== false;
}
