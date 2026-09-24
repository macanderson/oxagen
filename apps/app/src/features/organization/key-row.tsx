"use client";
// One row of the API keys table, and one clock for it.
//
// The page reads its keys once and the instant it read them travels with the
// rows. Two things on a row turn on that instant — the status word and whether
// Rotate is offered — and a page left open crosses an expiry without a reload,
// so both are judged here against a clock that keeps running. Splitting them
// gave a row that contradicted itself: Rotate withdrawn while the status still
// said "live".
//
// The clock itself is `@/ui/expiry-clock`, shared with the agent credential
// and host rows, which derive their own state from the same captured instant.
//
// This is the courtesy. `rotate_api_key` refuses an expired key and that
// refusal is the guarantee, on the API and MCP as well as here.
import { useTranslations } from "next-intl";
import type { ApiKey } from "@/data/contracts/org";
import {
  credentialState,
  type CredentialState,
} from "@/shared/credential-state";
import type { SafePath } from "@/shared/safe-path";
import { mono } from "@/ui/control-styles";
import { Badge } from "@/ui/badge";
import { useExpiryClock } from "@/ui/expiry-clock";
import { cell, numericCell } from "@/ui/table";
import { KeyRowActions } from "./create-key-dialog";
import { DateCell, NotRecorded } from "./parts";

/** How close an expiry must be before the badge warns of it. */
const EXPIRING_WITHIN_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The Expires cell: the key's state as a dot and a word, then the expiry date.
 * A live key reads "active", or "expires in N days" inside the last thirty
 * days, or "never used" when no request has presented it; an expired or a
 * revoked key says so. The words come from the key's own instants, judged on
 * this row's running clock.
 */
function KeyExpiry({
  apiKey,
  state,
  current,
}: {
  apiKey: ApiKey;
  state: CredentialState;
  current: number;
}) {
  const t = useTranslations("organization.apiKeys");
  const expiresAt =
    apiKey.expiresAt === null ? null : Date.parse(apiKey.expiresAt);
  const days =
    expiresAt === null ? null : Math.ceil((expiresAt - current) / DAY_MS);
  const badge =
    state === "revoked" ? (
      <Badge tone="quiet" data-status="revoked">
        {t("state.revoked")}
      </Badge>
    ) : state === "expired" ? (
      <Badge tone="denied" data-status="expired">
        {t("state.expired")}
      </Badge>
    ) : days !== null && days <= EXPIRING_WITHIN_DAYS ? (
      <Badge tone="approval" data-status="expiring">
        {t("state.expiring", { days })}
      </Badge>
    ) : apiKey.lastUsedAt === null ? (
      <Badge tone="quiet" data-status="never-used">
        {t("state.neverUsed")}
      </Badge>
    ) : (
      <Badge tone="allowed" data-status="live">
        {t("state.active")}
      </Badge>
    );
  return (
    <>
      {badge}
      <div className={`${mono} text-[11px] text-dim`}>
        {apiKey.expiresAt === null ? (
          t("never")
        ) : (
          <DateCell iso={apiKey.expiresAt} />
        )}
      </div>
    </>
  );
}

export function KeyRow({
  apiKey,
  org,
  ws,
  archived,
  now,
  listedIds,
  here,
  afterMint,
}: {
  apiKey: ApiKey;
  org: string;
  /** The workspace the key belongs to, and the one a new key is minted in. */
  ws: string;
  /**
   * Whether that workspace is archived. A rotation mints fresh secret material
   * for it, which is what archival is meant to stop, so `rotate_api_key`
   * refuses one (`conflict` / `workspace_archived`) and the control is
   * withheld. Revoke stays: it is the action an archived workspace's keys are
   * listed for, and the one that helps with a compromised key.
   */
  archived: boolean;
  /** The instant the keys were read; this row's clock starts there. */
  now: number;
  listedIds: readonly string[];
  /** This view — the same filter, the same page — where a revocation returns. */
  here: SafePath;
  /**
   * The first page of this filter, where a rotation returns. A rotation mints
   * a key and the roster is newest first, so the replacement is at the top of
   * the roster and nowhere else; returning to a later page would answer a
   * rotation with a screen that does not contain its result.
   */
  afterMint: SafePath;
}) {
  const t = useTranslations("organization.apiKeys");
  const current = useExpiryClock(apiKey.expiresAt, now);
  const state = credentialState(apiKey, current);
  // Rotate is offered only where it would work: the key is live on this row's
  // own clock, the read said no service owns it, and the workspace is still in
  // use.
  const mayRotate = state === "live" && apiKey.rotatable && !archived;
  return (
    <tr data-api-key={apiKey.id}>
      <td className={cell}>
        <div className="font-semibold text-foreground">{apiKey.name}</div>
        <div className={`${mono} text-[11px] text-dim`}>
          {t("masked", { prefix: apiKey.prefix })}
        </div>
      </td>
      {/* Principal, Grants and Created by: list_api_keys returns none of
          them, and Actions 30d below has no per-key count (#3934). */}
      <td className={cell}>
        <NotRecorded />
      </td>
      <td className={cell}>
        <NotRecorded />
      </td>
      <td className={cell}>
        <NotRecorded />
      </td>
      <td className={`${cell} ${mono} text-[11px] text-dim`}>
        {apiKey.lastUsedAt === null ? (
          t("neverUsed")
        ) : (
          <DateCell iso={apiKey.lastUsedAt} />
        )}
      </td>
      <td className={numericCell}>
        <NotRecorded />
      </td>
      <td className={cell}>
        <KeyExpiry apiKey={apiKey} state={state} current={current} />
      </td>
      <td className={cell}>
        {state === "revoked" ? null : (
          <KeyRowActions
            org={org}
            ws={ws}
            keyId={apiKey.id}
            keyName={apiKey.name}
            rotatable={mayRotate}
            listedIds={listedIds}
            after={here}
            afterRotate={afterMint}
          />
        )}
      </td>
    </tr>
  );
}
