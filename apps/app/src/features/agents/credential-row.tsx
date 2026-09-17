"use client";
// One row of the agent's credentials table, and one clock for it.
//
// The page reads the agent once and the instant it read it travels with the
// credentials. A credential's state turns on that instant, and a page left
// open crosses an expiry without a reload, so the row judges its own against a
// clock that keeps running (`@/ui/expiry-clock`, the same one the API-key row
// uses).
//
// The claim this row makes is what authority the agent actually holds, and a
// credential past its expiry holds none — `packages/auth/src/resolvers/api-key.ts`
// refuses it. That refusal is the guarantee; the word here is the courtesy.
import { useTranslations } from "next-intl";
import type { AgentDetail } from "@/data/contracts/agents";
import { credentialState } from "@/shared/credential-state";
import { mono } from "@/ui/control-styles";
import { useExpiryClock } from "@/ui/expiry-clock";
import { cell } from "@/ui/table";
import { Instant } from "./parts";

type Credential = AgentDetail["credentials"][number];

/**
 * The word for a credential's state, with the instant that ended it where the
 * table does not already print one: the revocation instant is recorded nowhere
 * else on the row, the expiry sits in the column beside this one.
 */
function CredentialStateCell({
  credential,
  state,
}: {
  credential: Credential;
  state: ReturnType<typeof credentialState>;
}) {
  const t = useTranslations("agents.detail.credentials");
  if (state === "revoked" && credential.revokedAt !== null) {
    return (
      <>
        {t("revoked")} <Instant at={credential.revokedAt} />
      </>
    );
  }
  return <>{t(state === "expired" ? "expired" : "active")}</>;
}

export function CredentialRow({
  credential,
  now,
}: {
  credential: Credential;
  /** The instant the agent was read; the clock runs on from it. */
  now: number;
}) {
  const t = useTranslations("agents.detail.credentials");
  // One instant for the whole row, so the word and the date beside it cannot
  // disagree as the page ages past the expiry.
  const state = credentialState(
    credential,
    useExpiryClock(credential.expiresAt, now),
  );
  return (
    <tr data-testid="credential-row">
      <td className={cell}>
        <span className={mono}>{credential.prefix}</span>
        <span className="block text-xs text-muted-foreground">
          {credential.name}
        </span>
      </td>
      <td className={cell}>
        <Instant at={credential.createdAt} />
      </td>
      <td className={cell}>
        {credential.lastUsedAt === null ? (
          t("never")
        ) : (
          <Instant at={credential.lastUsedAt} />
        )}
      </td>
      <td className={cell}>
        {credential.expiresAt === null ? (
          t("noExpiry")
        ) : (
          <Instant at={credential.expiresAt} />
        )}
      </td>
      <td className={cell} data-state={state}>
        <CredentialStateCell credential={credential} state={state} />
      </td>
    </tr>
  );
}
