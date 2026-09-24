"use client";
// The write surface of Organization › API keys: the button that mints a key,
// and the two controls a live key's row carries. There is no refused state for
// a role: `list_api_keys`, `create_api_key`, `rotate_api_key` and
// `revoke_api_key` are gated on the same org roles in the same place
// (API_KEY_AUTHORIZED_ROLES, packages/handlers/src/lib/api-key-authz.ts), so a
// viewer who is reading this table is a viewer who may write (INV-29), and the
// handler checks again anyway.
//
// A minted secret exists only here. `createApiKey` and `rotateApiKey` return it
// once and no read can bring it back, so the dialog holds it in client state
// until the roster the server sends names the new key — and drops it then, on
// the render that first lists the key. It is dropped rather than hidden: a
// value still held can be shown again by any later roster that does not list
// the key, and the workspace picker sends exactly that.
import { useTranslations } from "next-intl";
import { type ReactNode, type SyntheticEvent, useState } from "react";
import type { ActionResult } from "@/server/kernel";
import type { SafePath } from "@/shared/safe-path";
import { endOfUtcDay } from "@/shared/expiry-day";
import { buttonSecondary, inputBase, mono } from "@/ui/control-styles";
import { useExitGuard } from "@/ui/exit-guard";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import {
  createApiKey,
  type NewApiKey,
  revokeApiKey,
  rotateApiKey,
} from "./api-key-actions";
import { recordReceipt } from "./receipt";

type Failure = Exclude<ActionResult<unknown>, { ok: true }>;

/** A write that threw before it answered, as the seam would name it. */
const UNANSWERED: Failure = {
  ok: false,
  reason: "unavailable",
  code: "action_failed",
};

/** What a key write answers with: a secret to show once, or an id it ended. */
type Written = NewApiKey | { readonly keyId: string };

const secretOf = (written: Written): NewApiKey | null =>
  "secret" in written ? written : null;

/**
 * The sentence a refused key write shows. The kernel classified the refusal and
 * put the handler's code in `code` (§3.2), so each refusal the three handlers
 * produce has its own sentence and any other code is printed as recorded.
 */
function useFailureText(): (failure: Failure) => string {
  const t = useTranslations("organization.apiKeys.actions.failure");
  return (failure) => {
    switch (failure.reason) {
      case "denied":
        return t("denied");
      case "not_found":
      case "conflict":
        if (failure.code === "api_key_not_found") return t("keyNotFound");
        // The page's clock can be older than the key's expiry; the handler
        // judges against its own and is the authority (INV-29's shape: the
        // refusal is the guarantee, the control is a courtesy).
        if (failure.code === "api_key_expired") return t("keyExpired");
        // The page withholds Create in an archived workspace, so this is the
        // race: archived after the render, refused by the handler.
        if (failure.code === "workspace_archived")
          return t("workspaceArchived");
        return t("refused", { code: failure.code });
      case "invalid":
        switch (failure.code) {
          case "name_required":
            return t("nameRequired");
          case "expiry_not_a_day":
            return t("expiryNotADay");
          case "expiry_in_the_past":
            return t("expiryInThePast");
          default:
            return t("invalid");
        }
      case "pending_approval":
        return t("pendingApproval", {
          accessRequestId: failure.accessRequestId,
        });
      case "exhausted":
      case "unavailable":
        return t("unavailable", { code: failure.code });
    }
  };
}

/** The one showing of a secret: what it is called, and the key itself. */
function SecretPanel({ secret }: { secret: NewApiKey }) {
  const t = useTranslations("organization.apiKeys.actions.secret");
  return (
    <div className="flex flex-col gap-3" data-testid="api-key-secret">
      <p className="text-sm text-muted-foreground">{t("body")}</p>
      <code
        data-testid="api-key-secret-value"
        className={`${mono} block break-all rounded-md border border-border bg-muted px-3 py-2.5 text-foreground`}
      >
        {secret.secret}
      </code>
      <p className="text-sm text-muted-foreground">
        {t("named", { name: secret.name, prefix: secret.prefix })}
      </p>
    </div>
  );
}

/**
 * One dialog around one key write. The form is the caller's; an answer that
 * carries a secret replaces it with the one showing, and an answer that does
 * not closes the dialog. Closing reloads the roster when something changed.
 *
 * A secret always reaches the screen: the dialog cannot be dismissed while the
 * write is in flight, and an answer that carries one reopens the dialog if it
 * was closed before the write started. The write cannot be asked for its result
 * again and a rotation has already ended the key it replaced, so the result has
 * to find the person who asked for it.
 *
 * `listedIds` is the roster the server last sent. The first render on which it
 * names the key whose secret is on screen, the reload has landed: the secret is
 * cleared out of state and the dialog closes with it, so no later render can
 * bring it back.
 */
function KeyWriteDialog({
  open: openLabel,
  title,
  subtitle,
  confirm,
  pending: pendingLabel,
  testId,
  write,
  receipt,
  listedIds,
  after,
  children,
}: {
  open: string;
  title: string;
  /** The key the write acts on, under the title. */
  subtitle?: string;
  confirm: string;
  pending: string;
  testId: string;
  write: () => Promise<ActionResult<Written>>;
  /** The line the write leaves once it answered ok. */
  receipt: string;
  listedIds: readonly string[];
  /** The page, reloaded once a write answered. */
  after: SafePath;
  children?: ReactNode;
}) {
  const t = useTranslations("organization.apiKeys.actions");
  const failureText = useFailureText();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [written, setWritten] = useState<NewApiKey | null>(null);

  // The showing is over the moment the roster the server sent names the key,
  // and the secret leaves this component with it — cleared, not hidden. Holding
  // the value and deriving `null` around it means any later roster that does
  // not list the key brings it back, and switching the workspace picker sends
  // exactly such a roster (its keys are another workspace's). A secret shown
  // once has to be unrecoverable afterwards, not merely not on screen, so the
  // clearing happens here, during render, the way React adjusts state when a
  // prop changes.
  const listed = written !== null && listedIds.includes(written.id);
  if (listed) {
    setWritten(null);
    setOpen(false);
  }
  const secret = listed ? null : written;
  const showing = open && !listed;

  // The window where a secret can be lost: a write the server has not answered
  // yet, or one it answered with a secret nobody has acknowledged. Outside it
  // there is nothing to lose and the guard is down, so the prompt keeps its
  // meaning. `openChange` holds the dialog's own close paths; this holds the
  // browser's unload (`ui/exit-guard.ts`).
  useExitGuard(pending || secret !== null);

  function openChange(next: boolean) {
    // A key write in flight is not dismissable. The secret comes back once and
    // exists nowhere else, and a rotation has already revoked the key it
    // replaces, so an island unmounted mid-write — dismissed, then off to
    // another workspace, tab or page — loses a credential that was minted. The
    // dialog is modal over a scrim, so holding it also holds the navigation
    // behind it. Every close path (the footer button, Escape, the scrim) is
    // this one function.
    if (pending && !next) return;
    setOpen(next);
    setFailure(null);
    if (next) {
      setWritten(null);
      return;
    }
    if (secret !== null) {
      setWritten(null);
      navigate.replace(after);
    }
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await write();
      if (!result.ok) {
        setFailure(failureText(result));
        return;
      }
      recordReceipt(receipt);
      const minted = secretOf(result.value);
      if (minted === null) {
        setOpen(false);
        navigate.replace(after);
      } else {
        // The secret is shown even if the person dismissed the dialog while the
        // write was in flight. It exists nowhere else and cannot be asked for
        // again, and a rotation has already revoked the key it replaces in the
        // same transaction — closing the dialog early would otherwise leave the
        // integration with neither credential.
        setWritten(minted);
        setOpen(true);
      }
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={buttonSecondary}
        onClick={() => {
          openChange(true);
        }}
      >
        {openLabel}
      </button>
      <SheetDialog
        open={showing}
        onOpenChange={openChange}
        title={secret === null ? title : t("secret.title")}
        subtitle={secret === null ? subtitle : undefined}
        testId={testId}
      >
        {secret === null ? (
          <form
            onSubmit={(e) => void submit(e)}
            className="flex flex-col gap-3"
          >
            {children}
            {failure === null ? null : (
              <FormAlert testId={`${testId}-failure`}>{failure}</FormAlert>
            )}
            <SubmitButton
              pending={pending}
              label={confirm}
              pendingLabel={pendingLabel}
            />
          </form>
        ) : (
          <SecretPanel secret={secret} />
        )}
      </SheetDialog>
    </>
  );
}

/** The design's expiry choices, as a number of days from today or one year on. */
const EXPIRY_PRESETS = ["d90", "d180", "y1"] as const;
type ExpiryPreset = (typeof EXPIRY_PRESETS)[number];

/**
 * The calendar day, in UTC, a preset lands on from `now`: 90 or 180 days on,
 * or the same date a year on. The action takes a day and ends the key at the
 * end of it in UTC (`shared/expiry-day.ts`), so this hands it the day.
 *
 * @internal Exported for its unit test.
 */
export function expiryDayOf(preset: ExpiryPreset, now: Date): string {
  const day = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  if (preset === "y1") day.setUTCFullYear(day.getUTCFullYear() + 1);
  else day.setUTCDate(day.getUTCDate() + (preset === "d90" ? 90 : 180));
  return day.toISOString().slice(0, 10);
}

export function CreateKeyDialog({
  org,
  ws,
  listedIds,
  after,
}: {
  org: string;
  /** The workspace the key is minted in; a key names one (ADR-073). */
  ws: string;
  listedIds: readonly string[];
  after: SafePath;
}) {
  const t = useTranslations("organization.apiKeys.actions.create");
  const tReceipt = useTranslations("organization.receipts");
  const [name, setName] = useState("");
  const [preset, setPreset] = useState<ExpiryPreset>("d90");
  // The day is taken when the person submits, so a dialog left open past
  // midnight does not hand the action yesterday's arithmetic.
  const expiresOn = () => expiryDayOf(preset, new Date());
  // The note under the select prints the instant the chosen day encodes. The
  // action encodes with the same function, so the note and the stored value
  // cannot drift (`shared/expiry-day.ts`).
  const stored = endOfUtcDay(expiresOn());
  return (
    <KeyWriteDialog
      open={t("open")}
      title={t("title")}
      confirm={t("confirm")}
      pending={t("pending")}
      testId="create-api-key"
      write={() => createApiKey(org, ws, name, expiresOn())}
      receipt={tReceipt("keyCreated", { name: name.trim() })}
      listedIds={listedIds}
      after={after}
    >
      <p className="text-sm text-muted-foreground">{t("body")}</p>
      <label htmlFor="api-key-name" className="text-sm font-medium">
        {t("name")}
      </label>
      <input
        id="api-key-name"
        value={name}
        className={inputBase}
        onChange={(event) => {
          setName(event.currentTarget.value);
        }}
      />
      <label htmlFor="api-key-expires" className="text-sm font-medium">
        {t("expires")}
      </label>
      <select
        id="api-key-expires"
        value={preset}
        aria-describedby="api-key-expires-note"
        className={inputBase}
        onChange={(event) => {
          const { value } = event.currentTarget;
          setPreset(EXPIRY_PRESETS.find((p) => p === value) ?? "d90");
        }}
      >
        {EXPIRY_PRESETS.map((option) => (
          <option key={option} value={option}>
            {t(`expiresOptions.${option}`)}
          </option>
        ))}
      </select>
      {stored === null ? null : (
        <p id="api-key-expires-note" className="text-sm text-muted-foreground">
          {t("expiresAt", { at: stored })}
        </p>
      )}
    </KeyWriteDialog>
  );
}

export function KeyRowActions({
  org,
  ws,
  keyId,
  keyName,
  keyPrefix,
  rotatable,
  listedIds,
  after,
  afterRotate,
}: {
  org: string;
  /** The workspace the key belongs to; a key names one (ADR-073). */
  ws: string;
  keyId: string;
  keyName: string;
  /** The masked key, printed under the dialog titles beside the name. */
  keyPrefix?: string;
  /**
   * Whether Rotate is offered. The row decides it against its own clock and
   * what `list_api_keys` reported (`key-row.tsx`), so one place holds the rule
   * and the status word beside it cannot disagree with the controls.
   */
  rotatable: boolean;
  listedIds: readonly string[];
  /** Where a revocation returns: the view the person was reading. */
  after: SafePath;
  /**
   * Where a rotation returns: the first page of that view. The replacement key
   * is the newest, the roster is newest first, so that is the one page certain
   * to hold it — and the secret panel's close path navigates there.
   */
  afterRotate: SafePath;
}) {
  const t = useTranslations("organization.apiKeys.actions");
  const tReceipt = useTranslations("organization.receipts");
  const subtitle =
    keyPrefix === undefined ? keyName : `${keyName} ${keyPrefix}…`;
  return (
    <div className="flex flex-wrap gap-2">
      {rotatable ? (
        <KeyWriteDialog
          open={t("rotate.open")}
          title={t("rotate.title")}
          subtitle={subtitle}
          confirm={t("rotate.confirm")}
          pending={t("rotate.pending")}
          testId="rotate-api-key"
          write={() => rotateApiKey(org, ws, keyId)}
          receipt={tReceipt("keyRotated", { name: keyName })}
          listedIds={listedIds}
          after={afterRotate}
        >
          <p className="text-sm text-muted-foreground">{t("rotate.body")}</p>
        </KeyWriteDialog>
      ) : null}
      <KeyWriteDialog
        open={t("revoke.open")}
        title={t("revoke.title")}
        subtitle={subtitle}
        confirm={t("revoke.confirm")}
        pending={t("revoke.pending")}
        testId="revoke-api-key"
        write={() => revokeApiKey(org, ws, keyId)}
        receipt={tReceipt("keyRevoked", { name: keyName })}
        listedIds={listedIds}
        after={after}
      >
        <p className="text-sm text-muted-foreground">{t("revoke.body")}</p>
      </KeyWriteDialog>
    </div>
  );
}
