import { describe, expect, it } from "vitest";
import { coordinatorTunnel } from "./store-migrate-coordinator.mjs";

describe("production migration coordinator tunnel", () => {
  it("preserves credentials, database, and TLS identity while forwarding the port", () => {
    const source =
      "postgres://operator:p%40ss@cluster.example:5433/oxagen?sslmode=verify-full&application_name=migrate";
    const result = coordinatorTunnel(source);
    expect(result.host).toBe("cluster.example");
    expect(result.port).toBe("5433");
    const forwarded = new URL(result.url);
    expect(forwarded.port).toBe("15432");
    forwarded.port = "5433";
    expect(forwarded.href).toBe(source);
  });

  it("uses the Postgres default remote port when none is specified", () => {
    expect(
      coordinatorTunnel("postgresql://user:pass@cluster.example/oxagen"),
    ).toEqual({
      host: "cluster.example",
      port: "5432",
      url: "postgresql://user:pass@cluster.example:15432/oxagen",
    });
  });

  it.each([
    "https://cluster.example/oxagen",
    "postgres://cluster.example",
    "postgres://[::1]/oxagen",
  ])("refuses an unsupported coordination target: %s", (url) => {
    expect(() => coordinatorTunnel(url)).toThrow(/Postgres URL/);
  });
});
