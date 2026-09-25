"use client";
// Add a provider (mockup `tools.md`, the `import` dialog): three steps,
// Connect → Review tools/list → Classify and import.
//
//  1. **Connect** finds the provider and authenticates to it, all inside this
//     dialog (#4132). Three sources:
//       - **Browse** searches verified first-party servers and the official
//         MCP Registry (`search_mcp_registry`). Picking one fills in its
//         endpoint and says how it authenticates.
//       - **Custom** takes any streamable-http endpoint, an internal one
//         included, with OAuth, a bearer token, a header or no auth.
//       - **Already added** picks a provider on the roster.
//     OAuth runs in a popup (`use-provider-oauth.ts`): the person signs in to
//     the provider, the popup posts back and closes, and the wizard moves on.
//     A server that registers no OAuth clients itself (Slack, GitHub) asks for
//     the workspace's own OAuth app here, with the redirect URL to register.
//     A static credential goes through `register_mcp_server` as before.
//  2. **Review tools/list** offers every tool the provider listed, each checked,
//     so a person can leave one out, and a filter narrows a long list. A
//     provider picked from the roster lists no names on this read, so the step
//     offers the names its imported versions carry, takes any other typed, and
//     imports every pin when left blank.
//  3. **Classify and import** says what import does and does not do, then runs
//     `import_tools`: one immutable version per changed manifest, idempotent on
//     an unchanged one. An imported version lands unclassified; the tool dialog
//     is where it is classified.
//
// Every credential (a token, a header value, an OAuth client secret) is secret
// material: read off the form at submit, sent once, never held in state,
// never rendered back and never in a failure message.
import { useTranslations } from "next-intl";
import { chooseServerTools } from "@/features/shell/client";
import {
  type ReactNode,
  type SyntheticEvent,
  useEffect,
  useState,
} from "react";
import {
  MCP_AUTH_STRATEGIES,
  type McpAuthStrategy,
  REGISTERABLE_MCP_TRANSPORTS,
  type RegisterableMcpTransport,
  type RegistryServer,
} from "@/data/contracts/tools";
import {
  buttonPrimary,
  buttonSecondary,
  inputBase,
  mono,
} from "@/ui/control-styles";
import { parseProviderUrl } from "@/shared/provider-url";
import { FormAlert } from "@/ui/form-feedback";
import { ProviderLink, useNavigate } from "@/ui/navigation";
import { ProviderIcon } from "@/ui/provider-icon";
import { RecordMultiPicker } from "@/ui/record-picker";
import { SheetDialog } from "@/ui/sheet-dialog";
import { UNANSWERED, useActionFailure } from "./action-failure";
import { importTools, type McpServerDraft, registerServer } from "./actions";
import {
  type AuthorizationDraft,
  providerRedirectUrl,
} from "./provider-auth-actions";
import { RegistryBrowser } from "./registry-browser";
import { type OAuthPhase, useProviderOAuth } from "./use-provider-oauth";
import { parseMeasureLines, textValue, type ToolsAt } from "./view";

const TESTID = "tools-import";

type Step = 1 | 2 | 3;

const STEP_KEYS = { 1: "s1", 2: "s2", 3: "s3" } as const;

type Source = "browse" | "custom" | "existing";

/** Custom auth: OAuth sign-in, or one of the static strategies. */
type CustomAuth = "oauth" | McpAuthStrategy;
const CUSTOM_AUTHS: readonly CustomAuth[] = ["oauth", ...MCP_AUTH_STRATEGIES];

/** The provider the later steps work on, and the tool names it listed. */
type Connected = {
  id: string;
  name: string;
  /** Null when the provider came from the roster, which lists no names. */
  listed: readonly string[] | null;
};

function transportOf(raw: string): RegisterableMcpTransport {
  return (
    REGISTERABLE_MCP_TRANSPORTS.find((option) => option === raw) ??
    REGISTERABLE_MCP_TRANSPORTS[0]
  );
}

function customAuthOf(raw: string): CustomAuth {
  return CUSTOM_AUTHS.find((option) => option === raw) ?? "oauth";
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint === undefined ? null : (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

function Steps({ step }: { step: Step }) {
  const t = useTranslations("tools.import.steps");
  return (
    <ol
      aria-label={t("label")}
      className="mb-1 flex flex-wrap items-center gap-2 text-xs"
    >
      {([1, 2, 3] as const).map((n) => (
        <li
          key={n}
          aria-current={n === step ? "step" : undefined}
          data-step={n}
          className={`rounded border px-2 py-0.5 ${
            n === step
              ? "border-foreground text-foreground"
              : "border-border text-muted-foreground"
          }`}
        >
          {t(STEP_KEYS[n])}
        </li>
      ))}
    </ol>
  );
}

/** The redirect URL a workspace registers its OAuth app with, copyable. */
function RedirectUrl({ value }: { value: string }) {
  const t = useTranslations("tools.import.oauth");
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-sm font-medium text-foreground">
        {t("redirect")}
      </span>
      <div className="flex min-w-0 items-center gap-2">
        <code
          data-testid={`${TESTID}-redirect-url`}
          className={`${mono} min-w-0 flex-1 break-all rounded border border-border bg-muted px-2 py-1.5 text-xs`}
        >
          {value}
        </code>
        <button
          type="button"
          className={buttonSecondary}
          onClick={() => {
            // Absent over plain HTTP and refused by a browser that denies the
            // permission; the value stays on screen to select by hand.
            try {
              void navigator.clipboard
                .writeText(value)
                .then(() => {
                  setCopied(true);
                })
                .catch(() => undefined);
            } catch {
              // No clipboard in this context.
            }
          }}
        >
          {copied ? t("copied") : t("copy")}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">{t("redirectHint")}</p>
    </div>
  );
}

/**
 * The workspace's own OAuth app: required for a server that registers no
 * clients, optional (behind a disclosure) for any other OAuth server.
 */
function OAuthClientFields({
  at,
  required,
  scopes,
  redirectUrl,
  docsUrl,
}: {
  at: ToolsAt;
  required: boolean;
  scopes: string;
  /** The redirect URL a start answered with; read from the app when absent. */
  redirectUrl: string | null;
  docsUrl: string | null;
}) {
  const t = useTranslations("tools.import.oauth");
  const docs = parseProviderUrl(docsUrl);
  // The OAuth app is registered with the redirect URL before its client ID
  // exists, so the URL is shown before the first sign-in is attempted.
  const [loaded, setLoaded] = useState<string | null>(null);
  useEffect(() => {
    if (redirectUrl !== null) return;
    let live = true;
    providerRedirectUrl(at.org, at.ws)
      .then((result) => {
        if (live && result.ok) setLoaded(result.value.redirectUrl);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [at.org, at.ws, redirectUrl]);
  const shown = redirectUrl ?? loaded;
  const fields = (
    <div className="flex flex-col gap-3">
      {shown === null ? null : <RedirectUrl value={shown} />}
      <Field id="import-client-id" label={t("clientId")}>
        <input
          id="import-client-id"
          name="clientId"
          required={required}
          autoComplete="off"
          className={`${inputBase} ${mono}`}
        />
      </Field>
      <Field
        id="import-client-secret"
        label={t("clientSecret")}
        hint={t("clientSecretHint")}
      >
        <input
          id="import-client-secret"
          name="clientSecret"
          type="password"
          autoComplete="off"
          className={`${inputBase} ${mono}`}
        />
      </Field>
      <Field id="import-scopes" label={t("scopes")} hint={t("scopesHint")}>
        <textarea
          id="import-scopes"
          name="scopes"
          rows={2}
          defaultValue={scopes}
          autoComplete="off"
          className={`${inputBase} ${mono}`}
        />
      </Field>
      {docs === null ? null : (
        <ProviderLink
          to={docs}
          className="text-xs text-app-link-fg underline-offset-2 hover:underline"
        >
          {t("docs")}
        </ProviderLink>
      )}
    </div>
  );
  if (required) {
    return (
      <div
        data-testid={`${TESTID}-client-required`}
        className="flex flex-col gap-3 rounded-lg border border-border px-3 py-3"
      >
        <p className="text-[13px] text-foreground">{t("clientRequired")}</p>
        {fields}
      </div>
    );
  }
  return (
    <details className="rounded-lg border border-border px-3 py-2">
      <summary className="cursor-pointer text-[13px] text-foreground">
        {t("ownClient")}
      </summary>
      <div className="pt-3">{fields}</div>
    </details>
  );
}

/** The workspace's OAuth app as typed, read off the form and never stored. */
function clientOf(form: FormData): AuthorizationDraft["client"] {
  const clientId = textValue(form, "clientId").trim();
  if (clientId === "") return undefined;
  return {
    clientId,
    clientSecret: textValue(form, "clientSecret"),
    scopes: textValue(form, "scopes"),
  };
}

/** Where an OAuth sign-in stands, said above the footer. */
function OAuthStatus({
  phase,
  name,
  onCancel,
}: {
  phase: OAuthPhase;
  name: string;
  onCancel: () => void;
}) {
  const t = useTranslations("tools.import.oauth");
  if (phase.kind === "starting") {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t("starting")}
      </p>
    );
  }
  if (phase.kind !== "waiting") return null;
  return (
    <div
      role="status"
      data-testid={`${TESTID}-oauth-waiting`}
      className="flex flex-col gap-2 rounded-lg border border-border bg-muted px-3 py-2.5 text-sm"
    >
      <p className="text-foreground">
        {phase.blockedUrl === null
          ? t("waiting", { name })
          : t("blocked", { name })}
      </p>
      <div className="flex flex-wrap gap-2">
        {phase.blockedUrl === null ? null : (
          <ProviderLink
            to={phase.blockedUrl}
            data-testid={`${TESTID}-oauth-open`}
            className={buttonPrimary}
          >
            {t("openSignIn")}
          </ProviderLink>
        )}
        <button type="button" className={buttonSecondary} onClick={onCancel}>
          {t("cancel")}
        </button>
      </div>
    </div>
  );
}

export function ImportProvider({
  at,
  servers,
  primary = false,
  label = "import",
  compact = false,
}: {
  at: ToolsAt;
  /** The workspace's registered providers, or null when the roster read failed. */
  servers: readonly { id: string; name: string }[] | null;
  /** Gold only where it is the screen's one primary action. */
  primary?: boolean;
  /** "Import a provider" in the header and the Tools panel; "Add a provider" on Providers. */
  label?: "import" | "add";
  /** The Tools panel header's copy of the control: the trigger drops to one line. */
  compact?: boolean;
}) {
  const t = useTranslations("tools.import");
  const tOAuth = useTranslations("tools.import.oauth");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>(1);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [source, setSource] = useState<Source>("browse");
  const [picked, setPicked] = useState<RegistryServer | null>(null);
  const [existing, setExisting] = useState<string>("");
  const [customAuth, setCustomAuth] = useState<CustomAuth>("oauth");
  const [connected, setConnected] = useState<Connected | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [typed, setTyped] = useState<readonly string[]>([]);
  const [filter, setFilter] = useState("");
  const [done, setDone] = useState<{
    published: number;
    unchanged: number;
  } | null>(null);
  // The name the OAuth steps speak of: the picked server's, or the custom one's.
  const [signingInTo, setSigningInTo] = useState("");

  function toReview(next: Connected) {
    setConnected(next);
    setSelected(new Set(next.listed ?? []));
    setStep(2);
    setFailure(null);
    // The provider now exists whether or not anything is imported, so the
    // page behind the dialog re-reads its roster.
    navigate.refresh();
  }

  const oauth = useProviderOAuth(at, (outcome) => {
    toReview({
      id: outcome.serverId,
      name: outcome.name === "" ? signingInTo : outcome.name,
      listed: outcome.discoveredTools,
    });
  });

  function reset() {
    setStep(1);
    setFailure(null);
    setSource("browse");
    setPicked(null);
    setExisting("");
    setCustomAuth("oauth");
    setConnected(null);
    setSelected(new Set());
    setTyped([]);
    setFilter("");
    setDone(null);
    setSigningInTo("");
    oauth.reset();
  }

  function oauthFailure(code: string): string {
    switch (code) {
      case "access_denied":
        return tOAuth("failure.access_denied");
      case "authorization_expired":
        return tOAuth("failure.authorization_expired");
      case "authorization_failed":
        return tOAuth("failure.authorization_failed");
      case "authorization_discovery_failed":
        return tOAuth("failure.authorization_discovery_failed");
      case "authorization_url_invalid":
        return tOAuth("failure.authorization_url_invalid");
      case "endpoint_not_public":
        return tOAuth("failure.endpoint_not_public");
      case "redirect_url_invalid":
        return tOAuth("failure.redirect_url_invalid");
      case "server_not_found":
        return tOAuth("failure.server_not_found");
      case "org_role_required":
        return tOAuth("failure.org_role_required");
      default:
        return failureText({ ok: false, reason: "unavailable", code });
    }
  }

  async function register(draft: McpServerDraft) {
    setPending(true);
    try {
      const result = await registerServer(at.org, at.ws, draft);
      if (!result.ok) {
        setFailure(failureText(result));
        return;
      }
      toReview({
        id: result.value.serverId,
        name: draft.name.trim(),
        listed: result.value.discoveredTools,
      });
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  async function connect(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || oauth.phase.kind === "starting") return;
    setFailure(null);
    const form = new FormData(event.currentTarget);

    if (source === "existing") {
      const server = servers?.find((s) => s.id === existing);
      if (server === undefined) return;
      setConnected({ id: server.id, name: server.name, listed: null });
      setStep(2);
      return;
    }

    if (source === "browse") {
      if (picked === null || picked.endpointUrl === null) return;
      const name = textValue(form, "name").trim() || picked.name;
      setSigningInTo(name);
      if (picked.auth === "oauth" || picked.auth === "unknown") {
        const client = clientOf(form);
        await oauth.start({
          mode: "add",
          name,
          endpointUrl: picked.endpointUrl,
          registryId: picked.registryRef,
          ...(picked.iconUrl === null ? {} : { iconUrl: picked.iconUrl }),
          ...(picked.description === ""
            ? {}
            : { description: picked.description }),
          ...(client === undefined ? {} : { client }),
        });
        return;
      }
      const secret = textValue(form, "secret");
      await register({
        name,
        transportType: "streamable-http",
        endpointUrl: picked.endpointUrl,
        authStrategy: picked.auth,
        authConfig:
          picked.auth === "bearer"
            ? { token: secret }
            : picked.auth === "header"
              ? { [textValue(form, "headerName").trim()]: secret }
              : {},
      });
      return;
    }

    // Custom.
    const name = textValue(form, "name").trim();
    const endpointUrl = textValue(form, "endpointUrl");
    setSigningInTo(name);
    const chosen = customAuthOf(textValue(form, "authStrategy"));
    if (chosen === "oauth") {
      const client = clientOf(form);
      await oauth.start({
        mode: "add",
        name,
        endpointUrl,
        ...(client === undefined ? {} : { client }),
      });
      return;
    }
    const pairs =
      chosen === "none" ? [] : parseMeasureLines(textValue(form, "authConfig"));
    if (pairs === null) {
      setFailure(
        failureText({ ok: false, reason: "invalid", code: "invalid_input" }),
      );
      return;
    }
    await register({
      name,
      transportType: transportOf(textValue(form, "transportType")),
      endpointUrl,
      authStrategy: chosen,
      authConfig: Object.fromEntries(pairs),
    });
  }

  /** The names step 3 imports: the checked ones, or the picked ones (none is every pin). */
  const chosenTools: readonly string[] =
    connected?.listed === null ? typed : [...selected];

  async function runImport() {
    if (pending || connected === null) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await importTools(at.org, at.ws, {
        serverId: connected.id,
        tools: chosenTools,
      });
      if (!result.ok) {
        setFailure(failureText(result));
        return;
      }
      setDone({
        published: result.value.published,
        unchanged: result.value.unchanged,
      });
      // Re-read the tab the person is on rather than moving them: the dialog
      // may live in a tab's own panel (Add a provider on Providers), and
      // navigating away would unmount it before its receipt is read (#3800).
      navigate.refresh();
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  const phase = oauth.phase;
  const busy = pending || phase.kind === "starting";
  /** True when the Connect step's primary action runs OAuth. */
  const signsIn =
    (source === "browse" &&
      picked !== null &&
      (picked.auth === "oauth" || picked.auth === "unknown")) ||
    (source === "custom" && customAuth === "oauth");
  const clientRequired =
    phase.kind === "client_required" ||
    (source === "browse" && picked?.oauthRegistration === "client_required");
  const connectLabel = busy
    ? t("pending")
    : signsIn
      ? tOAuth("authorize", {
          name: source === "browse" ? (picked?.name ?? "") : t("theProvider"),
        })
      : t("connect");

  const listed = connected?.listed ?? null;
  const title =
    step === 1
      ? label === "add"
        ? t("addTitle")
        : t("title")
      : step === 2
        ? t("reviewTitle")
        : t("classifyTitle");
  const subtitle =
    step === 1
      ? t("subtitle")
      : listed === null
        ? connected?.name
        : t("reviewSubtitle", {
            count: listed.length,
            name: connected?.name ?? "",
          });

  const showConnect =
    source !== "browse" || (picked !== null && picked.connectable);
  const footer =
    step === 1 ? (
      showConnect ? (
        <button
          type="submit"
          form={`${TESTID}-connect`}
          data-testid={`${TESTID}-connect`}
          aria-disabled={busy || phase.kind === "waiting" || undefined}
          className={buttonPrimary}
        >
          {connectLabel}
        </button>
      ) : null
    ) : step === 2 ? (
      <>
        <button
          type="button"
          className={buttonSecondary}
          onClick={() => {
            setStep(1);
          }}
        >
          {t("back")}
        </button>
        <button
          type="button"
          data-testid={`${TESTID}-classify`}
          disabled={listed !== null && selected.size === 0}
          className={buttonPrimary}
          onClick={() => {
            setStep(3);
          }}
        >
          {t("classify")}
        </button>
      </>
    ) : (
      <>
        <button
          type="button"
          className={buttonSecondary}
          onClick={() => {
            setStep(2);
          }}
        >
          {t("back")}
        </button>
        <button
          type="button"
          data-testid={`${TESTID}-confirm`}
          aria-disabled={pending || done !== null || undefined}
          className={buttonPrimary}
          onClick={() => void runImport()}
        >
          {pending
            ? t("importing")
            : chosenTools.length === 0
              ? t("importAll")
              : t("importCount", { count: chosenTools.length })}
        </button>
      </>
    );

  const sources: readonly Source[] =
    servers !== null && servers.length > 0
      ? ["browse", "custom", "existing"]
      : ["browse", "custom"];

  return (
    <>
      <button
        type="button"
        data-testid={`${TESTID}-open`}
        className={`${primary ? buttonPrimary : buttonSecondary} ${compact ? "whitespace-nowrap" : ""}`}
        onClick={() => {
          setOpen(true);
        }}
      >
        {label === "add" ? t("openAdd") : t("open")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
        title={title}
        subtitle={subtitle}
        wide
        closeLabel={t("cancel")}
        testId={`${TESTID}-dialog`}
        footer={footer}
      >
        <div className="flex flex-col gap-3">
          <Steps step={step} />
          {step === 1 ? (
            <>
              <div
                role="radiogroup"
                aria-label={t("source.label")}
                className="flex flex-wrap gap-1.5"
              >
                {sources.map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={source === option}
                    data-testid={`${TESTID}-source-${option}`}
                    className={`rounded-md border px-3 py-1.5 text-[13px] max-md:min-h-11 ${
                      source === option
                        ? "border-foreground text-foreground"
                        : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                    onClick={() => {
                      setSource(option);
                      setFailure(null);
                      oauth.reset();
                    }}
                  >
                    {t(`source.${option}`)}
                  </button>
                ))}
              </div>

              {source === "browse" && picked === null ? (
                <RegistryBrowser
                  at={at}
                  onPick={(server) => {
                    setPicked(server);
                    setFailure(null);
                    oauth.reset();
                  }}
                />
              ) : (
                <form
                  id={`${TESTID}-connect`}
                  onSubmit={(e) => void connect(e)}
                  className="flex flex-col gap-3"
                >
                  {source === "browse" && picked !== null ? (
                    <>
                      <div
                        data-testid={`${TESTID}-picked`}
                        className="flex min-w-0 items-start gap-3 rounded-lg border border-border px-3 py-2.5"
                      >
                        <ProviderIcon
                          name={picked.name}
                          iconUrl={picked.iconUrl}
                          size={32}
                        />
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="font-semibold text-foreground">
                            {picked.name}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {picked.publisher}
                          </span>
                          <span
                            className={`${mono} break-all text-[11px] text-muted-foreground`}
                          >
                            {picked.endpointUrl}
                          </span>
                        </div>
                        <button
                          type="button"
                          className={buttonSecondary}
                          onClick={() => {
                            setPicked(null);
                            setFailure(null);
                            oauth.reset();
                          }}
                        >
                          {t("browse.change")}
                        </button>
                      </div>
                      <Field
                        id="import-name"
                        label={t("name")}
                        hint={t("nameHint")}
                      >
                        <input
                          id="import-name"
                          name="name"
                          required
                          maxLength={120}
                          defaultValue={picked.name}
                          className={inputBase}
                        />
                      </Field>
                      {picked.auth === "bearer" ? (
                        <Field
                          id="import-secret"
                          label={t("browse.token")}
                          hint={t("browse.secretHint")}
                        >
                          <input
                            id="import-secret"
                            name="secret"
                            type="password"
                            required
                            autoComplete="off"
                            className={`${inputBase} ${mono}`}
                          />
                        </Field>
                      ) : picked.auth === "header" ? (
                        <>
                          <Field id="import-header" label={t("browse.header")}>
                            <input
                              id="import-header"
                              name="headerName"
                              required
                              defaultValue={picked.authHeader ?? ""}
                              className={`${inputBase} ${mono}`}
                            />
                          </Field>
                          <Field
                            id="import-secret"
                            label={t("browse.headerValue")}
                            hint={t("browse.secretHint")}
                          >
                            <input
                              id="import-secret"
                              name="secret"
                              type="password"
                              required
                              autoComplete="off"
                              className={`${inputBase} ${mono}`}
                            />
                          </Field>
                        </>
                      ) : picked.auth === "none" ? (
                        <p className="text-[13px] text-muted-foreground">
                          {t("browse.noAuth")}
                        </p>
                      ) : (
                        <>
                          <p className="text-[13px] text-muted-foreground">
                            {picked.auth === "oauth"
                              ? tOAuth("explain", { name: picked.name })
                              : tOAuth("explainUnknown")}
                          </p>
                          <OAuthClientFields
                            key={
                              phase.kind === "client_required"
                                ? `client:${phase.scopes}`
                                : "client"
                            }
                            required={clientRequired}
                            scopes={
                              phase.kind === "client_required"
                                ? phase.scopes
                                : ""
                            }
                            redirectUrl={
                              phase.kind === "client_required"
                                ? phase.redirectUrl
                                : null
                            }
                            docsUrl={picked.docsUrl}
                            at={at}
                          />
                        </>
                      )}
                    </>
                  ) : null}

                  {source === "custom" ? (
                    <>
                      <Field
                        id="import-name"
                        label={t("name")}
                        hint={t("nameHint")}
                      >
                        <input
                          id="import-name"
                          name="name"
                          required
                          maxLength={120}
                          className={inputBase}
                        />
                      </Field>
                      <Field
                        id="import-endpoint"
                        label={t("endpoint")}
                        hint={t("endpointHint")}
                      >
                        <input
                          id="import-endpoint"
                          name="endpointUrl"
                          type="url"
                          required
                          className={`${inputBase} ${mono}`}
                        />
                      </Field>
                      <Field
                        id="import-transport"
                        label={t("wire")}
                        hint={t("wireHint")}
                      >
                        <select
                          id="import-transport"
                          name="transportType"
                          defaultValue={REGISTERABLE_MCP_TRANSPORTS[0]}
                          className={inputBase}
                        >
                          {REGISTERABLE_MCP_TRANSPORTS.map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field id="import-auth" label={t("auth")}>
                        <select
                          id="import-auth"
                          name="authStrategy"
                          value={customAuth}
                          onChange={(event) => {
                            setCustomAuth(
                              customAuthOf(event.currentTarget.value),
                            );
                            oauth.reset();
                          }}
                          className={inputBase}
                        >
                          {CUSTOM_AUTHS.map((option) => (
                            <option key={option} value={option}>
                              {t(`authStrategies.${option}`)}
                            </option>
                          ))}
                        </select>
                      </Field>
                      {customAuth === "oauth" ? (
                        <OAuthClientFields
                          key={
                            phase.kind === "client_required"
                              ? `client:${phase.scopes}`
                              : "client"
                          }
                          required={phase.kind === "client_required"}
                          scopes={
                            phase.kind === "client_required" ? phase.scopes : ""
                          }
                          redirectUrl={
                            phase.kind === "client_required"
                              ? phase.redirectUrl
                              : null
                          }
                          docsUrl={null}
                          at={at}
                        />
                      ) : customAuth === "none" ? null : (
                        <Field
                          id="import-auth-config"
                          label={t("authConfig")}
                          hint={t("authConfigHint")}
                        >
                          <textarea
                            id="import-auth-config"
                            name="authConfig"
                            rows={2}
                            required
                            autoComplete="off"
                            placeholder={t("authConfigPlaceholder")}
                            className={`${inputBase} ${mono}`}
                          />
                        </Field>
                      )}
                    </>
                  ) : null}

                  {source === "existing" ? (
                    <Field id="import-provider" label={t("provider")}>
                      <select
                        id="import-provider"
                        value={existing}
                        required
                        onChange={(event) => {
                          setExisting(event.currentTarget.value);
                        }}
                        className={inputBase}
                      >
                        <option value="" disabled>
                          {t("pickProvider")}
                        </option>
                        {(servers ?? []).map((server) => (
                          <option key={server.id} value={server.id}>
                            {server.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  ) : null}

                  <OAuthStatus
                    phase={phase}
                    name={signingInTo}
                    onCancel={oauth.reset}
                  />
                  {phase.kind === "not_oauth" ? (
                    <div
                      data-testid={`${TESTID}-not-oauth`}
                      className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2.5 text-[13px]"
                    >
                      <p className="text-foreground">{tOAuth("notOAuth")}</p>
                      {source === "browse" &&
                      picked !== null &&
                      picked.endpointUrl !== null ? (
                        <button
                          type="button"
                          data-testid={`${TESTID}-connect-open`}
                          className={`${buttonSecondary} self-start`}
                          onClick={() => {
                            if (picked.endpointUrl === null) return;
                            oauth.reset();
                            void register({
                              name: signingInTo || picked.name,
                              transportType: "streamable-http",
                              endpointUrl: picked.endpointUrl,
                              authStrategy: "none",
                              authConfig: {},
                            });
                          }}
                        >
                          {tOAuth("connectOpen")}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  {phase.kind === "failed" ? (
                    <FormAlert testId={`${TESTID}-oauth-failure`}>
                      {oauthFailure(phase.code)}
                    </FormAlert>
                  ) : null}
                  <p className="rounded-lg border border-border px-3 py-2.5 text-[13px] text-muted-foreground">
                    {t("connectNote")}
                  </p>
                </form>
              )}
            </>
          ) : null}

          {step === 2 ? (
            listed === null ? (
              <Field id="import-tools" label={t("tools")} hint={t("toolsHint")}>
                <RecordMultiPicker
                  id="import-tools"
                  freeform
                  load={() =>
                    chooseServerTools(at.org, at.ws, connected?.id ?? "")
                  }
                  value={typed}
                  onChange={setTyped}
                />
              </Field>
            ) : listed.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("nothingListed")}
              </p>
            ) : (
              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1 text-sm font-medium text-foreground">
                  {t("listed")}
                </legend>
                <label htmlFor="import-filter" className="sr-only">
                  {t("filter")}
                </label>
                <input
                  id="import-filter"
                  type="search"
                  value={filter}
                  placeholder={t("filter")}
                  autoComplete="off"
                  onChange={(event) => {
                    setFilter(event.currentTarget.value);
                  }}
                  className={`${inputBase} mb-1`}
                />
                {listed
                  .filter((tool) =>
                    tool.toLowerCase().includes(filter.trim().toLowerCase()),
                  )
                  .map((tool) => (
                    <label
                      key={tool}
                      className="flex min-h-9 items-center gap-2.5 rounded-md border border-border px-3 py-1.5 text-[13px] max-md:min-h-11"
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(tool)}
                        onChange={(event) => {
                          const next = new Set(selected);
                          if (event.currentTarget.checked) next.add(tool);
                          else next.delete(tool);
                          setSelected(next);
                        }}
                      />
                      <span className={mono}>{tool}</span>
                    </label>
                  ))}
                <p
                  data-testid={`${TESTID}-selected`}
                  className="text-xs text-muted-foreground"
                >
                  {t("selected", {
                    selected: selected.size,
                    total: listed.length,
                  })}
                </p>
              </fieldset>
            )
          ) : null}

          {step === 3 ? (
            <>
              {chosenTools.length === 0 ? (
                <p className="text-sm text-foreground">{t("allPins")}</p>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {chosenTools.map((tool) => (
                    <li
                      key={tool}
                      className={`${mono} rounded border border-border px-1.5 py-0.5 text-xs`}
                    >
                      {tool}
                    </li>
                  ))}
                </ul>
              )}
              <p className="rounded-lg border border-border px-3 py-2.5 text-[13px] text-muted-foreground">
                <b className="font-semibold text-foreground">
                  {t("grantsNothingTitle")}
                </b>{" "}
                {t("grantsNothing")}
              </p>
              {done === null ? null : (
                <div className="flex flex-col gap-2">
                  <p
                    role="status"
                    data-testid={`${TESTID}-done`}
                    className="rounded-lg border border-border bg-muted px-3 py-2.5 text-sm text-foreground"
                  >
                    {t("done", {
                      published: done.published,
                      unchanged: done.unchanged,
                    })}
                  </p>
                  {/* Several providers in one sitting: back to Connect, dialog open. */}
                  <button
                    type="button"
                    data-testid={`${TESTID}-another`}
                    className={`${buttonSecondary} self-start`}
                    onClick={reset}
                  >
                    {t("another")}
                  </button>
                </div>
              )}
            </>
          ) : null}

          {failure === null ? null : (
            <FormAlert testId={`${TESTID}-failure`}>{failure}</FormAlert>
          )}
        </div>
      </SheetDialog>
    </>
  );
}
