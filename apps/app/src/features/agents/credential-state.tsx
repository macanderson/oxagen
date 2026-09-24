"use client";
// The run credential's state as a dot and a word, judged against a clock that
// keeps running.
//
// The page reads the agent once and the instant it read it travels with the
// credential. A credential's state turns on that instant, and a page left open
// crosses an expiry without a reload, so the word judges its own against a
// clock that keeps running (`@/ui/expiry-clock`, the same one the API-key row
// uses). A credential past its expiry holds no authority:
// `packages/auth/src/resolvers/api-key.ts` refuses it. That refusal is the
// guarantee; the word here is the courtesy.
import { useTranslations } from "next-intl";
import type { AgentDetail } from "@/data/contracts/agents";
import { credentialState } from "@/shared/credential-state";
import { Badge } from "@/ui/badge";
import { useExpiryClock } from "@/ui/expiry-clock";

type Credential = AgentDetail["credentials"][number];

export function CredentialStateWord({
  credential,
  now,
}: {
  credential: Credential;
  /** The instant the agent was read; the clock runs on from it. */
  now: number;
}) {
  const t = useTranslations("agents.detail.identity.runCredential.state");
  const state = credentialState(
    credential,
    useExpiryClock(credential.expiresAt, now),
  );
  return (
    <span data-testid="credential-state" data-state={state}>
      <Badge tone={state === "live" ? "allowed" : "quiet"}>{t(state)}</Badge>
    </span>
  );
}
