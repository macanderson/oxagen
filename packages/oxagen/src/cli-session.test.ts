/**
 * The CLI session purpose is a stored value: it is written into
 * `auth.api_keys.scope` by the token exchange and read back by `resolveApiKey`
 * and `machineKeyDenial` on every call a terminal makes. Changing the string
 * silently strands every key already minted with the old one, so it is pinned
 * literally rather than compared to itself.
 */
import { describe, it, expect } from "vitest";
import {
  CLI_SESSION_SCOPE_PURPOSE,
  requestsReservedCliSessionPurpose,
} from "./cli-session";
import { AGENT_CREDENTIAL_SCOPE_PURPOSE } from "./agent-credential";

describe("CLI_SESSION_SCOPE_PURPOSE", () => {
  it("is the value already written to auth.api_keys.scope", () => {
    expect(CLI_SESSION_SCOPE_PURPOSE).toBe("cli_session_v1");
  });

  it("is distinct from every other reserved purpose", () => {
    expect(CLI_SESSION_SCOPE_PURPOSE).not.toBe(AGENT_CREDENTIAL_SCOPE_PURPOSE);
  });
});

describe("requestsReservedCliSessionPurpose", () => {
  it("recognises a request to self-assert the purpose", () => {
    expect(
      requestsReservedCliSessionPurpose({
        purpose: CLI_SESSION_SCOPE_PURPOSE,
      }),
    ).toBe(true);
  });

  it("does not recognise another purpose, or none", () => {
    expect(requestsReservedCliSessionPurpose({ purpose: "tacho_host_v1" })).toBe(
      false,
    );
    expect(requestsReservedCliSessionPurpose({ note: "cli" })).toBe(false);
  });

  it("answers false for a non-object scope rather than throwing", () => {
    for (const scope of [null, undefined, "cli_session_v1", 7]) {
      expect(requestsReservedCliSessionPurpose(scope)).toBe(false);
    }
  });
});
