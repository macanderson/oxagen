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
// until the roster the server sends names the new key. What the panel shows is
// derived from that roster rather than stored, so a re-render from server data
// ends the showing on its own.
import { useTranslations } from "next-intl";
import { type ReactNode, type SyntheticEvent, useState } from "react";
import type { ActionResult } from "@/server/kernel";
import type { SafePath } from "@/shared/safe-path";
import { buttonSecondary, inputBase, mono } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import {
  createApiKey,
  type NewApiKey,
  revokeApiKey,
  rotateApiKey,
} from "./api-key-actions";

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
        return failure.code === "api_key_not_found"
          ? t("keyNotFound")
          : t("refused", { code: failure.code });
      case "invalid":
        switch (failure.code) {
          case "name_required":
            return t("nameRequired");
          case "expiry_not_a_day":
            return t("expiryNotADay");
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
 * `listedIds` is the roster the server last sent. When it names the key whose
 * secret is on screen, the reload has landed, the panel is not rendered again
 * and the dialog closes with it.
 */
function KeyWriteDialog({
  open: openLabel,
  title,
  confirm,
  pending: pendingLabel,
  testId,
  write,
  listedIds,
  after,
  children,
}: {
  open: string;
  title: string;
  confirm: string;
  pending: string;
  testId: string;
  write: () => Promise<ActionResult<Written>>;
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

  // The showing is over the moment the roster the server sent names the key.
  // Both of these are derived, never stored, so a re-render from server data
  // takes the panel off the screen and closes the dialog with it.
  const secret =
    written !== null && !listedIds.includes(written.id) ? written : null;
  const showing = open && (written === null || secret !== null);

  function openChange(next: boolean) {
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
      const minted = secretOf(result.value);
      if (minted === null) {
        setOpen(false);
        navigate.replace(after);
      } else {
        setWritten(minted);
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

export function CreateKeyDialog({
  org,
  listedIds,
  after,
}: {
  org: string;
  listedIds: readonly string[];
  after: SafePath;
}) {
  const t = useTranslations("organization.apiKeys.actions.create");
  const [name, setName] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  return (
    <KeyWriteDialog
      open={t("open")}
      title={t("title")}
      confirm={t("confirm")}
      pending={t("pending")}
      testId="create-api-key"
      write={() => createApiKey(org, name, expiresOn)}
      listedIds={listedIds}
      after={after}
    >
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
      <input
        id="api-key-expires"
        type="date"
        value={expiresOn}
        className={inputBase}
        onChange={(event) => {
          setExpiresOn(event.currentTarget.value);
        }}
      />
      <p className="text-sm text-muted-foreground">{t("body")}</p>
    </KeyWriteDialog>
  );
}

export function KeyRowActions({
  org,
  keyId,
  keyName,
  listedIds,
  after,
}: {
  org: string;
  keyId: string;
  keyName: string;
  listedIds: readonly string[];
  after: SafePath;
}) {
  const t = useTranslations("organization.apiKeys.actions");
  return (
    <div className="flex flex-wrap gap-2">
      <KeyWriteDialog
        open={t("rotate.open")}
        title={t("rotate.title", { name: keyName })}
        confirm={t("rotate.confirm")}
        pending={t("rotate.pending")}
        testId="rotate-api-key"
        write={() => rotateApiKey(org, keyId)}
        listedIds={listedIds}
        after={after}
      >
        <p className="text-sm text-muted-foreground">{t("rotate.body")}</p>
      </KeyWriteDialog>
      <KeyWriteDialog
        open={t("revoke.open")}
        title={t("revoke.title", { name: keyName })}
        confirm={t("revoke.confirm")}
        pending={t("revoke.pending")}
        testId="revoke-api-key"
        write={() => revokeApiKey(org, keyId)}
        listedIds={listedIds}
        after={after}
      >
        <p className="text-sm text-muted-foreground">{t("revoke.body")}</p>
      </KeyWriteDialog>
    </div>
  );
}
