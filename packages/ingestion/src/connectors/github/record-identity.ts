class GithubRecordIdentityError extends Error {
  readonly code = "github_record_identity_missing";
}

/** Stable issue and pull-request identities, independent of repository-local numbers. */
export function githubRecordIdentity(
  kind: "issue" | "pull_request",
  raw: Record<string, unknown>,
): { externalId: string; legacyExternalId?: string } {
  const legacy = raw.number ?? raw.id;
  const legacyExternalId =
    typeof legacy === "string" || typeof legacy === "number"
      ? String(legacy)
      : undefined;
  if (
    (typeof raw.id === "number" &&
      Number.isSafeInteger(raw.id) &&
      raw.id > 0) ||
    (typeof raw.id === "string" && /^[1-9]\d*$/.test(raw.id))
  ) {
    return { externalId: `${kind}:id:${String(raw.id)}`, legacyExternalId };
  }
  if (typeof raw.node_id === "string" && raw.node_id.length > 0) {
    return { externalId: `${kind}:node:${raw.node_id}`, legacyExternalId };
  }
  if (typeof raw.html_url === "string") {
    try {
      const url = new URL(raw.html_url);
      if (url.protocol === "https:" || url.protocol === "http:") {
        return {
          externalId: `${kind}:url:${url.origin}${url.pathname}`,
          legacyExternalId,
        };
      }
    } catch {
      // A malformed URL cannot establish repository identity.
    }
  }
  throw new GithubRecordIdentityError(
    "GitHub record has no global ID or source URL. Retry with the complete provider record.",
  );
}
