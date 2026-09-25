/**
 * `sessionScopeOf` and `sessionScopeForEnrollment`: what tachod derives
 * session uuids from, and when an enrollment keeps its predecessor's scope
 * (ADR-178). A scope that changed on re-enrollment split every live session
 * into a second run that replayed its transcript (#4201). A scope that
 * carried where ingest would not hand the session over left the session
 * refused as another host's.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type HostFile,
  readHostFile,
  sessionScopeForEnrollment,
  sessionScopeOf,
  writeHostFile,
} from "./host-file";
import {
  bundleSigner,
  TEST_ENROLLMENT,
  testHostFile,
  unsignedBundle,
} from "./test-support";

const signer = bundleSigner();
const bundle = signer.sign(unsignedBundle());
const NEXT = "tch_nextenrollment0000000";

function previous(overrides: Partial<HostFile> = {}): HostFile {
  return testHostFile(signer, bundle, overrides);
}

function nextFor(host: HostFile, overrides: Partial<HostFile> = {}) {
  return {
    host_enrollment_id: NEXT,
    organization_id: host.organization_id,
    workspace_id: host.workspace_id,
    device_key_fingerprint: host.device_key_fingerprint,
    ...overrides,
  };
}

describe("sessionScopeOf", () => {
  it("reads session_scope when host.json has one", () => {
    expect(sessionScopeOf(previous({ session_scope: "tch_kept" }))).toBe(
      "tch_kept",
    );
  });

  it("falls back to the enrollment id for a host.json written before the field", () => {
    expect(sessionScopeOf(previous())).toBe(TEST_ENROLLMENT);
  });

  it("survives a round trip through host.json", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tacho-scope-")), "host.json");
    writeHostFile(path, previous({ session_scope: "tch_kept" }));
    expect(readHostFile(path)?.session_scope).toBe("tch_kept");
  });
});

describe("sessionScopeForEnrollment", () => {
  it("starts a first enrollment on its own enrollment id", () => {
    expect(
      sessionScopeForEnrollment(nextFor(previous()), undefined),
    ).toBe(NEXT);
  });

  it("keeps the scope of a re-enrollment into the same workspace once the old one is revoked", () => {
    const host = previous({ session_scope: "tch_first" });
    expect(
      sessionScopeForEnrollment(nextFor(host), { host, revoked: true }),
    ).toBe("tch_first");
  });

  it("carries a legacy host's enrollment id forward as the scope", () => {
    // Every live session on that host has a uuid hashed from this id.
    const host = previous();
    expect(
      sessionScopeForEnrollment(nextFor(host), { host, revoked: true }),
    ).toBe(TEST_ENROLLMENT);
  });

  it("keeps the scope when the control plane answers with the same enrollment", () => {
    const host = previous({ session_scope: "tch_first" });
    expect(
      sessionScopeForEnrollment(
        nextFor(host, { host_enrollment_id: TEST_ENROLLMENT }),
        { host, revoked: false },
      ),
    ).toBe("tch_first");
  });

  it("starts fresh while the old enrollment is still live", () => {
    // Ingest refuses the session to a new host while its owner is live, so
    // a carried uuid would be quarantined rather than recorded.
    const host = previous({ session_scope: "tch_first" });
    expect(
      sessionScopeForEnrollment(nextFor(host), { host, revoked: false }),
    ).toBe(NEXT);
  });

  it("starts fresh in another workspace", () => {
    const host = previous({ session_scope: "tch_first" });
    expect(
      sessionScopeForEnrollment(nextFor(host, { workspace_id: "wrk_2" }), {
        host,
        revoked: true,
      }),
    ).toBe(NEXT);
  });

  it("starts fresh in another organization", () => {
    const host = previous({ session_scope: "tch_first" });
    expect(
      sessionScopeForEnrollment(nextFor(host, { organization_id: "org_2" }), {
        host,
        revoked: true,
      }),
    ).toBe(NEXT);
  });

  it("starts fresh under another device key", () => {
    const host = previous({ session_scope: "tch_first" });
    expect(
      sessionScopeForEnrollment(
        nextFor(host, { device_key_fingerprint: "a-different-key" }),
        { host, revoked: true },
      ),
    ).toBe(NEXT);
  });
});
