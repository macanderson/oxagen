"use client";
// The two cells of an API keys row that turn on time: Expires, with the
// key's state as a dot and a word, and the row's Rotate and Revoke.
//
// The page reads its keys once and the instant it read them travels with the
// rows. Both cells turn on that instant, and a page left open crosses an
// expiry without a reload, so both are judged against a clock that keeps
// running. Each cell runs the clock from the same captured instant and the
// same expiry, through the same `credentialState`, so the two cannot
// disagree: Rotate is never withdrawn while the status still says "live".
// The rest of the row is static and is drawn by the section
// (`api-keys.tsx`), which hands every cell to the shared list table.
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
import { KeyRowActions } from "./create-key-dialog";
import { DateCell } from "./parts";

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

/** The Expires cell on its own running clock. */
export function KeyExpiryCell({
  apiKey,
  now,
}: {
  apiKey: ApiKey;
  /** The instant the keys were read; the clock starts there. */
  now: number;
}) {
  const current = useExpiryClock(apiKey.expiresAt, now);
  return (
    <KeyExpiry
      apiKey={apiKey}
      state={credentialState(apiKey, current)}
      current={current}
    />
  );
}

/**
 * The row's controls on the same clock: Rotate is offered only where it would
 * work (the key is live, the read said no service owns it, and the workspace
 * is still in use), and a revoked key has none.
 */
export function KeyActionsCell({
  apiKey,
  org,
  ws,
  archived,
  now,
  listedIds,
  after,
}: {
  apiKey: ApiKey;
  org: string;
  /** The workspace the key belongs to. */
  ws: string;
  /**
   * Whether that workspace is archived. A rotation mints fresh secret material
   * for it, which is what archival is meant to stop, so `rotate_api_key`
   * refuses one (`conflict` / `workspace_archived`) and the control is
   * withheld. Revoke stays: it is the action an archived workspace's keys are
   * listed for, and the one that helps with a compromised key.
   */
  archived: boolean;
  /** The instant the keys were read; the clock starts there. */
  now: number;
  listedIds: readonly string[];
  /** This view, the same workspace and filter, where every write returns. */
  after: SafePath;
}) {
  const current = useExpiryClock(apiKey.expiresAt, now);
  const state = credentialState(apiKey, current);
  if (state === "revoked") return null;
  return (
    <KeyRowActions
      org={org}
      ws={ws}
      keyId={apiKey.id}
      keyName={apiKey.name}
      keyPrefix={apiKey.prefix}
      rotatable={state === "live" && apiKey.rotatable && !archived}
      listedIds={listedIds}
      after={after}
      afterRotate={after}
    />
  );
}
