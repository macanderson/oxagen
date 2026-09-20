/** Preserve the database identity and TLS hostname through an SSM tunnel. */
export function coordinatorTunnel(connectionString) {
  const url = new URL(connectionString);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !/^[a-z0-9][a-z0-9.-]*$/i.test(url.hostname) ||
    !url.pathname.slice(1)
  ) {
    throw new Error(
      "Coordinator requires a Postgres URL with a DNS host and database",
    );
  }
  const host = url.hostname;
  const port = url.port || "5432";
  url.port = "15432";
  return { host, port, url: url.href };
}
