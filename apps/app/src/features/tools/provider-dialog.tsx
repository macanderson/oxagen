"use client";
// One provider (mockup `tools.md`, the `server` drill-down): the system, the
// transport it is reached over, what the registry holds from it, how it is
// authorized, and only its own tool versions. Opened from a Providers row and
// from the Provider cell of a Tools row, so the chain Provider → Tool reads
// both ways.
//
// Every row in the roster is an MCP server today, so the transport is `mcp`
// and the wire is the one the row records. What the record does not hold is
// said, not filled: the system's description, the last import, the belts and
// agents it reaches (#3852, #3917), and its authorization, which has no token
// lifecycle behind it yet (#3918).
//
// The footer's writes: Remove is `delete_mcp_server`, Re-import tools is
// `import_tools` on this provider. Edit has no write (#3917) and says so.
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import type { McpServer, ToolVersion } from "@/data/contracts/tools";
import { routes } from "@/shared/safe-path";
import { buttonSecondary, mono } from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { formatCount } from "@/ui/money-format";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { cell, numericCell, Table } from "@/ui/table";
import { UNANSWERED, useActionFailure } from "./action-failure";
import { importTools, removeProvider } from "./actions";
import { buttonDanger, buttonGhost } from "./buttons";
import { gapRef } from "./gaps";
import { NotBackedValue } from "./not-backed";
import { NotCarried, StateDot } from "./parts";
import { GateDot, HazardCell } from "./registry-cells";
import { StubAction, StubField } from "./stub-action";
import { ToolDialog } from "./tool-dialog";
import { type ToolsAt, versionLabel } from "./view";

/** The eight transports a provider may take, and the five wires (spec). */
const PROVIDER_TRANSPORTS = [
  "mcp",
  "http",
  "graphql",
  "sdk",
  "cli",
  "native",
  "local",
  "rpc",
] as const;
const PROVIDER_WIRES = [
  "streamable-http",
  "https",
  "stdio",
  "in-process",
  "hook",
] as const;

/** Everything the drill-down needs about one provider, all of it serialisable. */
export type ProviderView = {
  server: McpServer;
  /** The registry's versions from this provider, of the page that was read. */
  versions: readonly ToolVersion[];
  /** False while the registry has a later page, so the versions may be more. */
  complete: boolean;
};

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </div>
  );
}

export function RemoveProvider({
  at,
  server,
  onRemoved,
}: {
  at: ToolsAt;
  server: McpServer;
  /** What the opener does once the provider is gone: the drill-down closes. */
  onRemoved?: () => void;
}) {
  const t = useTranslations("tools.providers.remove");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  async function remove() {
    if (pending) return;
    setPending(true);
    setFailure(null);
    setNotFound(false);
    try {
      const result = await removeProvider(at.org, at.ws, server.id);
      if (!result.ok) {
        setFailure(failureText(result));
        return;
      }
      if (!result.value.deleted) {
        setNotFound(true);
        return;
      }
      setOpen(false);
      onRemoved?.();
      navigate.replace(routes.tools(at.org, at.ws, { tab: "providers" }));
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
        data-testid={`provider-remove-open-${server.id}`}
        className={buttonDanger}
        onClick={() => {
          setOpen(true);
        }}
      >
        {t("open")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setFailure(null);
            setNotFound(false);
          }
        }}
        title={t("title", { name: server.name })}
        subtitle={server.id}
        closeLabel={t("cancel")}
        testId="provider-remove-dialog"
        footer={
          <button
            type="button"
            data-testid="provider-remove-confirm"
            aria-disabled={pending || undefined}
            className={buttonDanger}
            onClick={() => void remove()}
          >
            {pending ? t("pending") : t("confirm")}
          </button>
        }
      >
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-foreground">{t("stops")}</p>
          <p className="text-muted-foreground">{t("kept")}</p>
          <p className="text-muted-foreground">{t("switchNote")}</p>
          {notFound ? (
            <p
              data-testid="provider-remove-not-found"
              className="rounded-lg border border-border bg-muted px-3 py-2.5 text-foreground"
            >
              {t("notFound")}
            </p>
          ) : null}
          {failure === null ? null : (
            <FormAlert testId="provider-remove-failure">{failure}</FormAlert>
          )}
        </div>
      </SheetDialog>
    </>
  );
}

function Reimport({ at, server }: { at: ToolsAt; server: McpServer }) {
  const t = useTranslations("tools.providers.reimport");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function run() {
    if (pending) return;
    setPending(true);
    setFailure(null);
    setOutcome(null);
    try {
      const result = await importTools(at.org, at.ws, {
        serverId: server.id,
        tools: [],
      });
      if (result.ok) {
        setOutcome(
          t("done", {
            published: result.value.published,
            unchanged: result.value.unchanged,
          }),
        );
        navigate.refresh();
        return;
      }
      setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        data-testid={`provider-reimport-${server.id}`}
        aria-disabled={pending || undefined}
        className={buttonSecondary}
        onClick={() => void run()}
      >
        {pending ? t("pending") : t("open")}
      </button>
      {outcome === null ? null : (
        <p
          role="status"
          data-testid="provider-reimport-done"
          className="text-xs text-foreground"
        >
          {outcome}
        </p>
      )}
      {failure === null ? null : (
        <FormAlert testId="provider-reimport-failure">{failure}</FormAlert>
      )}
    </div>
  );
}

function EditProvider({ server }: { server: McpServer }) {
  const t = useTranslations("tools.providers.edit");
  return (
    <StubAction
      label={t("open")}
      title={t("title", { name: server.name })}
      gap="providers"
      note={t("note")}
      confirm={t("confirm")}
      testId={`provider-edit-${server.id}`}
    >
      <StubField
        id={`edit-endpoint-${server.id}`}
        label={t("endpoint")}
        placeholder={server.endpointUrl}
      />
      <StubField
        id={`edit-transport-${server.id}`}
        label={t("transport")}
        options={PROVIDER_TRANSPORTS}
      />
      <StubField
        id={`edit-wire-${server.id}`}
        label={t("wire")}
        options={[
          server.transportType,
          ...PROVIDER_WIRES.filter((w) => w !== server.transportType),
        ]}
      />
      <StubField id={`edit-connection-${server.id}`} label={t("connection")} />
      <p className="text-xs text-muted-foreground">{t("hint")}</p>
    </StubAction>
  );
}

/** The OAuth dialog (`oauth`): what authorizing would take, with its refusal rule. */
function OAuthDialog({ server }: { server: McpServer }) {
  const t = useTranslations("tools.providers.oauth");
  return (
    <StubAction
      label={t("open")}
      tone="secondary"
      title={t("title", { name: server.name })}
      gap="oauth"
      note={t("note")}
      confirm={t("confirm", { name: server.name })}
      testId={`provider-oauth-${server.id}`}
    >
      <StubField id={`oauth-client-${server.id}`} label={t("clientId")} />
      <StubField id={`oauth-secret-${server.id}`} label={t("clientSecret")} />
      <StubField id={`oauth-url-${server.id}`} label={t("authUrl")} />
      <StubField id={`oauth-scopes-${server.id}`} label={t("scopes")} />
      <StubField
        id={`oauth-redirect-${server.id}`}
        label={t("redirect")}
        hint={t("redirectHint")}
      />
      <p className="text-xs text-muted-foreground">{t("refusal")}</p>
    </StubAction>
  );
}

const HEALTH_TONE = {
  healthy: "ok",
  degraded: "warn",
  unreachable: "deny",
  unknown: "neutral",
} as const;

export function HealthDot({ health }: { health: McpServer["healthStatus"] }) {
  const t = useTranslations("tools.providers.health");
  return (
    <StateDot tone={HEALTH_TONE[health]} name={health} label={t(health)} />
  );
}

/** The `mcp.<server>` prefix a version is governed under, read off the record. */
function registryName(versions: readonly ToolVersion[]): string | null {
  const capability = versions[0]?.capability;
  if (capability === undefined) return null;
  const cut = capability.lastIndexOf(".");
  return cut > 0 ? capability.slice(0, cut) : capability;
}

export function ProviderDialog({
  at,
  view,
  canAdminister,
  canClassify,
  open,
  onOpenChange,
}: {
  at: ToolsAt;
  view: ProviderView;
  canAdminister: boolean;
  canClassify: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("tools.providers.drill");
  const locale = useLocale();
  const { server, versions, complete } = view;
  const name = registryName(versions);
  const declared = versions.filter((v) => v.schemaOrigin === "declared").length;
  const imported = versions.length - declared;
  return (
    <SheetDialog
      open={open}
      onOpenChange={onOpenChange}
      title={server.name}
      subtitle={t("subtitle", {
        wire: server.transportType,
        endpoint: server.endpointUrl,
      })}
      wide
      testId="provider-dialog"
      footer={
        canAdminister ? (
          <>
            <RemoveProvider
              at={at}
              server={server}
              onRemoved={() => {
                onOpenChange(false);
              }}
            />
            <Reimport at={at} server={server} />
            <EditProvider server={server} />
          </>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4 text-[13px]">
        {server.healthStatus === "degraded" ||
        server.healthStatus === "unreachable" ? (
          <p
            data-testid="provider-health-warning"
            className="rounded-lg border border-warning/50 bg-warning/10 px-3 py-2.5 text-foreground"
          >
            {t(`healthWarning.${server.healthStatus}`)}
          </p>
        ) : null}
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
          <Row term={t("facts.system")}>{server.name}</Row>
          <Row term={t("facts.transport")}>
            <span className="flex flex-col gap-0.5">
              <span className={mono}>{t("transportMcp")}</span>
              <span className="text-xs text-muted-foreground">
                {t("transportLine")}
              </span>
            </span>
          </Row>
          <Row term={t("facts.registryName")}>
            {name === null ? (
              <NotCarried />
            ) : (
              <span className={mono}>{name}</span>
            )}
          </Row>
          <Row term={t("facts.schemas")}>
            {versions.length === 0 ? (
              <NotCarried />
            ) : (
              t("schemas", { declared, imported })
            )}
          </Row>
          <Row term={t("facts.versions")}>
            {complete
              ? formatCount(versions.length, locale)
              : t("atLeast", { count: versions.length })}
          </Row>
          <Row term={t("facts.toolbelts")}>
            <NotBackedValue gap="toolbelts" />
          </Row>
          <Row term={t("facts.agents")}>
            <NotBackedValue gap="toolbelts" />
          </Row>
          <Row term={t("facts.lastImport")}>
            <NotBackedValue gap="providers" />
          </Row>
          <Row term={t("facts.lastCheck")}>
            <span className="flex items-center gap-2">
              <HealthDot health={server.healthStatus} />
            </span>
          </Row>
        </dl>

        <section
          aria-labelledby="provider-auth"
          className="flex flex-col gap-2"
        >
          <h3 id="provider-auth" className="text-[13.5px] font-semibold">
            {t("authTitle")}
          </h3>
          <p
            data-state="not-backed"
            data-gap={gapRef("oauth")}
            className="rounded-lg border border-dashed border-border px-3 py-2.5 text-muted-foreground"
          >
            {t("authNotBacked")}
          </p>
          {canAdminister ? (
            <div className="flex flex-wrap gap-2">
              <OAuthDialog server={server} />
              <StubAction
                label={t("keyInstead")}
                title={t("keyTitle")}
                gap="oauth"
                note={t("keyNote")}
                confirm={t("keyConfirm")}
                testId={`provider-key-${server.id}`}
              />
            </div>
          ) : null}
        </section>

        <section
          aria-labelledby="provider-tools"
          className="flex flex-col gap-2"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="provider-tools" className="text-[13.5px] font-semibold">
              {t("toolsTitle", { name: server.name })}
            </h3>
          </div>
          {versions.length === 0 ? (
            <p className="text-muted-foreground">{t("noTools")}</p>
          ) : (
            <Table
              label={t("toolsTitle", { name: server.name })}
              columns={[
                { label: t("columns.version") },
                { label: t("columns.hazard") },
                { label: t("columns.gate") },
                { label: t("columns.agents") },
                { label: t("columns.calls"), numeric: true },
              ]}
            >
              {versions.map((version) => (
                <tr key={version.id} data-tool-version={version.id}>
                  <td className={cell}>
                    <ToolDialog
                      at={at}
                      version={version}
                      canClassify={canClassify}
                    >
                      <span className="flex flex-col gap-0.5">
                        <span className="font-medium">{version.name}</span>
                        <span
                          className={`${mono} text-xs text-muted-foreground`}
                        >
                          {versionLabel(version)}
                        </span>
                      </span>
                    </ToolDialog>
                  </td>
                  <td className={cell}>
                    <HazardCell version={version} />
                  </td>
                  <td className={cell}>
                    <GateDot version={version} />
                  </td>
                  <td className={cell}>
                    <NotBackedValue gap="toolbelts" />
                  </td>
                  <td className={numericCell}>
                    {version.calls30d === null ? (
                      <NotCarried />
                    ) : (
                      formatCount(version.calls30d, locale)
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          )}
          {complete ? null : (
            <p className="text-xs text-muted-foreground">{t("partial")}</p>
          )}
        </section>
      </div>
    </SheetDialog>
  );
}

/** A button that opens one provider's drill-down: the Provider cell of a Tools row. */
export function ProviderButton({
  at,
  view,
  canAdminister,
  canClassify,
}: {
  at: ToolsAt;
  view: ProviderView;
  canAdminister: boolean;
  canClassify: boolean;
}) {
  const t = useTranslations("tools.providers");
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-provider-open={view.server.id}
        aria-label={t("openNamed", { name: view.server.name })}
        className={`${buttonGhost} rounded-md border-border`}
        onClick={() => {
          setOpen(true);
        }}
      >
        {view.server.name}
      </button>
      <ProviderDialog
        at={at}
        view={view}
        canAdminister={canAdminister}
        canClassify={canClassify}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
