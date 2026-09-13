// Agent keys and the organization's address, derived the way the spec names them.
//   agent key: `org_ns.ws_ns.slug` (ADR-024, spec §3 "Agent", §6.2)
//   namespace: 2–6 lowercase letters or digits, immutable (App. A `org.organizations.namespace`,
//              the live `organizations_namespace_check`)
//   slug:      lowercase letters, digits and hyphens (the `create_org` contract)
import { z } from "zod";
import { type SdkLanguage } from "./steps";

export const NAMESPACE_PATTERN = /^[a-z0-9]{2,6}$/;
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Org-level route segments a workspace slug may not take (plan §4.11: they would shadow /{org}/<segment>). */
export const RESERVED_WORKSPACE_SLUGS: ReadonlySet<string> = new Set([
  "access",
  "api-keys",
  "audit",
  "billing",
  "developer",
  "members",
  "register",
  "roles",
  "security",
  "settings",
  "workspaces",
]);

/** Lowercase, hyphen-separated, trimmed of edge hyphens, at most `max` characters. */
export function toSlug(input: string, max = 40): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

/** A namespace suggestion from a slug: its first alphanumeric run, cut to six characters. */
export function suggestNamespace(slug: string): string {
  const compact =
    slug.split("-").find((part) => part.length >= 2) ?? slug.replace(/-/g, "");
  return compact.replace(/[^a-z0-9]/g, "").slice(0, 6);
}

export const AgentSlug = z
  .string()
  .trim()
  .min(2, { error: "agentSlugInvalid" })
  .max(40, { error: "agentSlugInvalid" })
  .regex(SLUG_PATTERN, { error: "agentSlugInvalid" });

export function agentKey(
  orgNamespace: string,
  workspaceNamespace: string,
  slug: string,
): string {
  return `${orgNamespace}.${workspaceNamespace}.${slug}`;
}

export type SdkSnippet = { install: string; code: string };

/** The five-line `oxagen.agent.wrap({})` snippet (spec §2 "wrapping an agent") for one language. */
export function sdkSnippet(language: SdkLanguage, key: string): SdkSnippet {
  const quoted = JSON.stringify(key);
  switch (language) {
    case "ts":
      return {
        install: "npm i @oxagen/sdk",
        code: [
          'import { oxagen } from "@oxagen/sdk";',
          "const agent = oxagen.agent.wrap({",
          `  key: ${quoted},`,
          "  token: process.env.OXAGEN_AGENT_TOKEN,",
          "});",
        ].join("\n"),
      };
    case "py":
      return {
        install: "pip install oxagen",
        code: [
          "from oxagen import oxagen",
          "agent = oxagen.agent.wrap(",
          `    key=${quoted},`,
          '    token=os.environ["OXAGEN_AGENT_TOKEN"],',
          ")",
        ].join("\n"),
      };
    case "go":
      return {
        install: "go get github.com/oxagen/oxagen-go",
        code: [
          'import "github.com/oxagen/oxagen-go"',
          "agent := oxagen.Agent.Wrap(oxagen.WrapOptions{",
          `    Key:   ${quoted},`,
          '    Token: os.Getenv("OXAGEN_AGENT_TOKEN"),',
          "})",
        ].join("\n"),
      };
  }
}

/** The scripted enrollment path (spec §7.2: `oxagen agent enroll` for managed fleets). */
export function enrollCommand(
  harness: "claude-code" | "codex-cli",
  token: string | null,
): string {
  const parts = ["oxagen agent enroll"];
  if (harness === "codex-cli") parts.push("--harness codex-cli");
  if (token) parts.push(`--token ${token}`);
  return parts.join(" ");
}
