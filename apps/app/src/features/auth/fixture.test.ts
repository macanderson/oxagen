import { describe, expect, it, vi } from "vitest";
import { FIXTURE_USER } from "@/server/fixture-session";
import { InvitationView } from "./invitation";
import {
  FIXTURE_INVITATIONS,
  FIXTURE_PASSWORD,
  fixtureCredentialsMatch,
  fixtureInvitation,
} from "./fixture";

function fixtureMode() {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("MC_DATA", "fixture");
}

describe("fixture sign-in data", () => {
  it("matches the fixture operator's credentials in fixture mode", () => {
    fixtureMode();
    expect(
      fixtureCredentialsMatch(
        ` ${FIXTURE_USER.email.toUpperCase()} `,
        FIXTURE_PASSWORD,
      ),
    ).toBe(true);
    expect(fixtureCredentialsMatch(FIXTURE_USER.email, "wrong-password")).toBe(
      false,
    );
  });

  it("never matches in a production build, even with MC_DATA=fixture", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MC_DATA", "fixture");
    expect(fixtureCredentialsMatch(FIXTURE_USER.email, FIXTURE_PASSWORD)).toBe(
      false,
    );
    expect(fixtureInvitation("invi_acme_pending")).toBeNull();
  });

  it("never matches outside fixture mode", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MC_DATA", "live");
    expect(fixtureCredentialsMatch(FIXTURE_USER.email, FIXTURE_PASSWORD)).toBe(
      false,
    );
  });

  it("serves only known invitation tokens, not prototype keys", () => {
    fixtureMode();
    expect(fixtureInvitation("invi_acme_pending")?.status).toBe("pending");
    expect(fixtureInvitation("toString")).toBeNull();
    expect(fixtureInvitation("invi_missing")).toBeNull();
  });

  it("every fixture invitation satisfies the view model", () => {
    for (const invitation of Object.values(FIXTURE_INVITATIONS)) {
      expect(InvitationView.safeParse(invitation).success).toBe(true);
    }
  });
});
