// A Studio server's Connection tab (#4678, "Connection"): where the server
// comes from, its environments and the one agents call, how it
// authenticates, and when it last synced.
//
// A credential shows only as its vault reference (`oxagen:credential/<name>`).
// Replacing one is written on this tab and kept in the vault, never in the
// steering folder, so a credential never reaches a steering PR. The form
// (credential-form.tsx) stores a service secret or an OAuth client's id and
// secret through set_mcp_credential (#4742). An operator's own OAuth sign-in
// is replaced through the Reconnect link beside it. Until discovery records the server's folder, the
// tab shows what the
// registry row holds: the endpoint, the transport, the auth kind and the
// status light the Providers tab draws.
//
// A URL can carry a credential too, as user info or as a query value, so the
// tab hides both wherever it shows an address (#4678, item 12).
import { useTranslations } from "next-intl";
import { type ReactNode, useId } from "react";
import type { McpServer } from "@/data/contracts/tools";
import {
  ProviderAuthorization,
  ProviderStatusLight,
  ReconnectProvider,
} from "@/features/tools";
import { Badge } from "@/ui/badge";
import {
  kvList,
  kvTerm,
  kvValue,
  mono,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { cell, Table } from "@/ui/table";
import { CredentialForm } from "./credential-form";
import type {
  StudioAuthMode,
  StudioEnvironment,
  StudioRecord,
  StudioSource,
} from "./model";
import { StudioNotRecorded, StudioNotRecordedValue } from "./not-recorded";
import type { StudioAt } from "./route";

/** Catalogue keys hold no hyphen, so the hyphenated values map here. */
const AUTH_MODE_KEY = {
  none: "none",
  service: "service",
  "operator-oauth": "operatorOauth",
} as const satisfies Record<StudioAuthMode, string>;

const SCHEDULE_KEY = {
  "on-change": "onChange",
  daily: "daily",
  manual: "manual",
} as const satisfies Record<StudioRecord["sync"]["schedule"], string>;

/**
 * A server the local gateway runs on enrolled machines: a local command, or a
 * registry entry whose package runs on named machine groups. Oxagen sends it
 * no credential, and it has no network route and no environments.
 */
function runsOnMachines(source: StudioSource): boolean {
  return (
    source.type === "local" ||
    (source.type === "registry" && source.machines.length > 0)
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className={kvTerm}>{term}</dt>
      <dd className={kvValue}>{children}</dd>
    </>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <span className={mono}>{children}</span>;
}

/**
 * `oxagen:credential/<name>`, as CREDENTIAL_REF_PATTERN in
 * packages/oxagen/src/steering-repo/names.ts spells it. The app may not import
 * that module (test/arch/layers.ts), so the pattern is copied here.
 */
const CREDENTIAL_REF = /^oxagen:credential\/[a-z0-9][a-z0-9-]{0,62}$/;
const CREDENTIAL_PREFIX = "oxagen:credential/";

/** The name a vault reference carries, or "" when the value is not one. */
function credentialName(value: string | null): string {
  return value !== null && CREDENTIAL_REF.test(value)
    ? value.slice(CREDENTIAL_PREFIX.length)
    : "";
}

/**
 * A query or fragment parameter whose name reads like a secret. Loose on
 * purpose: hiding a harmless value costs less than showing a key.
 */
const SECRET_PARAM =
  /token|secret|passw|pwd|key|auth|sig|credential|session|code/i;

/**
 * Whether a parameter name reads like a secret, tested as written and as the
 * recipient reads it. A name may percent-encode any of its characters, so
 * `%74oken` is `token` to the server that receives it and has to be hidden
 * like one. A malformed escape such as `%zz` makes decodeURIComponent throw,
 * and then the name as written is the only reading there is.
 */
function secretName(name: string): boolean {
  if (SECRET_PARAM.test(name)) return true;
  try {
    return SECRET_PARAM.test(decodeURIComponent(name));
  } catch {
    return false;
  }
}

/**
 * Text that holds URLs, as the tab shows it: each URL's user info and each
 * query or fragment value whose name reads like a secret replaced with `***`.
 * The user info rule is redactUrlCredentials in
 * packages/config/src/public-url.ts, copied because the app does not depend on
 * @oxagen/config.
 */
function redactUrls(text: string): string {
  return text
    .replace(
      /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/?#\s]*@/g,
      (_match, scheme: string) => `${scheme}***@`,
    )
    .replace(
      /([?&;#])([^=&;#\s]+)=([^&;#\s]*)/g,
      (match, separator: string, name: string) =>
        secretName(name) ? `${separator}${name}=***` : match,
    );
}

/** A URL, or a command line that may carry one, with its secrets hidden. */
function Address({ value }: { value: string }) {
  return <Code>{redactUrls(value)}</Code>;
}

/**
 * A credential as the record names it. Only a vault reference is shown. Any
 * other text could be a secret someone pasted into server.toml, so the tab
 * withholds it and says why.
 */
function Credential({ value }: { value: string }) {
  const t = useTranslations("mcpStudio.connection");
  return CREDENTIAL_REF.test(value) ? (
    <Code>{value}</Code>
  ) : (
    <span data-testid="studio-credential-withheld">{t("withheld")}</span>
  );
}

function Section({
  id,
  title,
  testId,
  children,
}: {
  id: string;
  title: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} data-testid={testId} className={panel}>
      <header className={panelHeader}>
        <h2 id={id} className={panelTitle}>
          {title}
        </h2>
      </header>
      <div className={`${panelBody} flex flex-col gap-3`}>{children}</div>
    </section>
  );
}

/** A list of names, or the sentence for none. */
function Names({ names, none }: { names: readonly string[]; none: string }) {
  return names.length === 0 ? (
    <span className="text-muted-foreground">{none}</span>
  ) : (
    <Code>{names.join(", ")}</Code>
  );
}

function SourceFacts({ source }: { source: StudioSource }) {
  const t = useTranslations("mcpStudio.connection");
  const network = (value: string | null) => (
    <Code>{value ?? t("cloud")}</Code>
  );
  switch (source.type) {
    case "remote":
      return (
        <>
          <Fact term={t("facts.url")}>
            <Address value={source.url} />
          </Fact>
          <Fact term={t("facts.transport")}>
            <Code>{source.transport}</Code>
          </Fact>
          <Fact term={t("facts.network")}>{network(source.network)}</Fact>
        </>
      );
    case "registry":
      return (
        <>
          <Fact term={t("facts.registry")}>
            <Address value={source.registry} />
          </Fact>
          <Fact term={t("facts.server")}>
            <Code>{source.server}</Code>
          </Fact>
          <Fact term={t("facts.version")}>
            <Code>{source.version}</Code>
          </Fact>
          {source.machines.length === 0 ? (
            <Fact term={t("facts.network")}>{network(source.network)}</Fact>
          ) : (
            <>
              <Fact term={t("facts.packageType")}>
                {source.registryType === null ? (
                  <StudioNotRecordedValue gap="record" />
                ) : (
                  <Code>{source.registryType}</Code>
                )}
              </Fact>
              <Fact term={t("facts.machines")}>
                <Names names={source.machines} none={t("noMachines")} />
              </Fact>
              <Fact term={t("facts.env")}>
                <Names names={source.env} none={t("none")} />
              </Fact>
            </>
          )}
        </>
      );
    case "local":
      return (
        <>
          <Fact term={t("facts.command")}>
            <Address value={[source.command, ...source.args].join(" ")} />
          </Fact>
          <Fact term={t("facts.machines")}>
            <Names names={source.machines} none={t("noMachines")} />
          </Fact>
          <Fact term={t("facts.env")}>
            <Names names={source.env} none={t("none")} />
          </Fact>
        </>
      );
    case "openapi":
    case "graphql":
    case "grpc":
      return (
        <>
          <Fact term={t("facts.from")}>{t(`from.${source.from}`)}</Fact>
          {source.repo === null ? null : (
            <Fact term={t("facts.repo")}>
              <Address value={source.repo} />
            </Fact>
          )}
          {source.path === null ? null : (
            <Fact term={t("facts.path")}>
              <Code>{source.path}</Code>
            </Fact>
          )}
          {source.ref === null ? null : (
            <Fact term={t("facts.ref")}>
              <Code>{source.ref}</Code>
            </Fact>
          )}
          {source.url === null ? null : (
            <Fact term={t("facts.url")}>
              <Address value={source.url} />
            </Fact>
          )}
          <Fact term={t("facts.network")}>{network(source.network)}</Fact>
        </>
      );
  }
}

function Source({
  server,
  record,
}: {
  server: McpServer;
  record: StudioRecord | null;
}) {
  const t = useTranslations("mcpStudio.connection");
  const kinds = useTranslations("tools.providers.status");
  const id = useId();
  return (
    <Section
      id={`${id}-h`}
      title={t("source.title")}
      testId="studio-connection-source"
    >
      {record === null ? (
        <StudioNotRecorded gap="record" testId="studio-source-missing">
          {t("source.missing")}
        </StudioNotRecorded>
      ) : null}
      <dl className={kvList}>
        <Fact term={t("facts.type")}>
          {record === null ? (
            <StudioNotRecordedValue gap="record" />
          ) : (
            t(`sourceTypes.${record.source.type}`)
          )}
        </Fact>
        {record === null ? (
          <>
            <Fact term={t("facts.endpoint")}>
              <Address value={server.endpointUrl} />
            </Fact>
            <Fact term={t("facts.transport")}>
              <Code>{server.transportType}</Code>
            </Fact>
            <Fact term={t("facts.auth")}>
              {kinds(`kinds.${server.authKind}`)}
            </Fact>
          </>
        ) : (
          <SourceFacts source={record.source} />
        )}
        <Fact term={t("facts.status")}>
          <ProviderStatusLight server={server} />
        </Fact>
      </dl>
    </Section>
  );
}

function Environments({
  environments,
  agentEnvironment,
  record,
}: {
  environments: readonly StudioEnvironment[];
  agentEnvironment: string | null;
  record: StudioRecord | null;
}) {
  const t = useTranslations("mcpStudio.connection.environments");
  const connection = useTranslations("mcpStudio.connection");
  const id = useId();
  /** An environment with no credential of its own uses the server's. */
  const credentialOf = (env: StudioEnvironment): ReactNode => {
    if (env.credential !== null) return <Credential value={env.credential} />;
    if (record === null) return <StudioNotRecordedValue gap="record" />;
    if (record.auth.mode === "none") return t("noCredential");
    return record.auth.credential === null ? (
      "—"
    ) : (
      <Credential value={record.auth.credential} />
    );
  };
  return (
    <Section
      id={`${id}-h`}
      title={t("title")}
      testId="studio-connection-environments"
    >
      <p
        data-testid="studio-agent-environment"
        className="text-sm text-muted-foreground"
      >
        {agentEnvironment === null
          ? t("agentsUnset")
          : t("agentsCall", { name: agentEnvironment })}
      </p>
      <Table
        label={t("title")}
        columns={[
          { label: t("columns.name") },
          { label: t("columns.url") },
          { label: t("columns.network") },
          { label: t("columns.credential") },
          { label: t("columns.agents") },
        ]}
      >
        {environments.map((env) => (
          <tr key={env.name} data-testid={`studio-environment-${env.name}`}>
            <td className={cell}>
              <span className="flex flex-wrap items-center gap-1.5">
                <Code>{env.name}</Code>
                {env.sandbox ? <Badge tone="quiet">{t("sandbox")}</Badge> : null}
              </span>
            </td>
            <td className={`${cell} ${mono} wrap-anywhere`}>
              {env.url === null ? "—" : redactUrls(env.url)}
            </td>
            <td className={`${cell} ${mono}`}>
              {env.network ?? connection("cloud")}
            </td>
            <td className={cell}>{credentialOf(env)}</td>
            <td className={cell}>
              {env.name === agentEnvironment ? (
                <Badge
                  tone="allowed"
                  data-testid={`studio-agent-badge-${env.name}`}
                >
                  {t("agentBadge")}
                </Badge>
              ) : (
                "—"
              )}
            </td>
          </tr>
        ))}
      </Table>
    </Section>
  );
}

function Auth({
  at,
  server,
  record,
  canEdit,
}: {
  at: StudioAt;
  server: McpServer;
  record: StudioRecord | null;
  canEdit: boolean;
}) {
  const t = useTranslations("mcpStudio.connection.auth");
  const id = useId();
  const noteId = `${id}-note`;
  return (
    <Section id={`${id}-h`} title={t("title")} testId="studio-connection-auth">
      <dl className={kvList}>
        <Fact term={t("mode")}>
          {record === null ? (
            <ProviderAuthorization server={server} />
          ) : (
            t(`modes.${AUTH_MODE_KEY[record.auth.mode]}`)
          )}
        </Fact>
        {record === null || record.auth.scheme === null ? null : (
          <Fact term={t("scheme")}>
            <Code>{record.auth.scheme}</Code>
          </Fact>
        )}
        <Fact term={t("credential")}>
          {record === null ? (
            <StudioNotRecordedValue gap="record" />
          ) : record.auth.credential === null ? (
            "—"
          ) : (
            <Credential value={record.auth.credential} />
          )}
        </Fact>
      </dl>
      {canEdit ? (
        <div className="flex flex-col gap-3">
          <CredentialForm
            at={at}
            defaultName={credentialName(record?.auth.credential ?? null)}
            defaultKind={
              record?.auth.mode === "operator-oauth" ? "oauth_client" : "secret"
            }
          />
          <div className="flex flex-wrap items-center gap-2">
            <ReconnectProvider at={at} server={server} />
          </div>
        </div>
      ) : null}
      <p id={noteId} className="text-sm text-muted-foreground">
        {t("note")}
      </p>
    </Section>
  );
}

/** A server the local gateway runs: which machines, and that it gets no credential. */
function Machines({ source }: { source: StudioSource }) {
  const t = useTranslations("mcpStudio.connection.machines");
  const id = useId();
  const groups =
    source.type === "local" || source.type === "registry"
      ? source.machines
      : [];
  return (
    <Section
      id={`${id}-h`}
      title={t("title")}
      testId="studio-connection-machines"
    >
      <p className="text-sm text-muted-foreground">{t("body")}</p>
      <p className="text-sm text-foreground">
        {groups.length === 0 ? t("none") : <Code>{groups.join(", ")}</Code>}
      </p>
    </Section>
  );
}

function Sync({ record }: { record: StudioRecord | null }) {
  const t = useTranslations("mcpStudio.connection.sync");
  const format = useFormatter();
  const id = useId();
  return (
    <Section id={`${id}-h`} title={t("title")} testId="studio-connection-sync">
      <dl className={kvList}>
        <Fact term={t("schedule")}>
          {record === null ? (
            <StudioNotRecordedValue gap="record" />
          ) : (
            t(`schedules.${SCHEDULE_KEY[record.sync.schedule]}`)
          )}
        </Fact>
        <Fact term={t("lastAt")}>
          {record === null ? (
            <StudioNotRecordedValue gap="record" />
          ) : record.sync.lastAt === null ? (
            t("never")
          ) : (
            format.dateTime(new Date(record.sync.lastAt), {
              dateStyle: "medium",
              timeStyle: "short",
            })
          )}
        </Fact>
      </dl>
    </Section>
  );
}

export function ConnectionTab({
  at,
  server,
  record,
  environments,
  agentEnvironment,
  canEdit,
}: {
  at: StudioAt;
  server: McpServer;
  record: StudioRecord | null;
  environments: readonly StudioEnvironment[];
  agentEnvironment: string | null;
  /** Whether the viewer may administer the workspace's tools. */
  canEdit: boolean;
}) {
  const local = record !== null && runsOnMachines(record.source);
  return (
    <div className="flex flex-col gap-4" data-testid="studio-connection">
      <Source server={server} record={record} />
      {record !== null && local ? (
        <Machines source={record.source} />
      ) : (
        <>
          <Environments
            environments={environments}
            agentEnvironment={agentEnvironment}
            record={record}
          />
          <Auth at={at} server={server} record={record} canEdit={canEdit} />
        </>
      )}
      <Sync record={record} />
    </div>
  );
}
