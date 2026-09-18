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
import { useExpiryClock } from "@/ui/expiry-clock";
import { cell } from "@/ui/table";
import { KeyRowActions } from "./create-key-dialog";
import { DateCell } from "./parts";

/** The key's state as a dot and a word. */
function KeyStatus({ state }: { state: CredentialState }) {
  const t = useTranslations("organization.apiKeys.status");
  return (
    <span
      data-status={state}
      className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-foreground"
    >
      <span
        aria-hidden="true"
        className={`size-2 rounded-full ${state === "live" ? "bg-success" : state === "expired" ? "bg-warning" : "bg-muted-foreground"}`}
      />
      {t(state)}
    </span>
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
      <td className={`${cell} font-medium text-foreground`}>{apiKey.name}</td>
      <td className={`${cell} ${mono}`}>{apiKey.prefix}</td>
      <td className={cell}>
        <DateCell iso={apiKey.createdAt} />
      </td>
      <td className={cell}>
        {apiKey.lastUsedAt === null ? (
          t("neverUsed")
        ) : (
          <DateCell iso={apiKey.lastUsedAt} />
        )}
      </td>
      <td className={cell}>
        {apiKey.expiresAt === null ? (
          t("never")
        ) : (
          <DateCell iso={apiKey.expiresAt} />
        )}
      </td>
      <td className={cell}>
        <KeyStatus state={state} />
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
