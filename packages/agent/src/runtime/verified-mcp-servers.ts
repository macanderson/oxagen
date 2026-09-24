// First-party remote MCP servers Oxagen lists above the registry's results
// (#4132). Several vendors run a remote server and do not publish it to the
// official MCP Registry (Slack's `mcp.slack.com` is the plainest case), so a
// search of the registry alone cannot find them.
//
// Every row was checked on 2026-09-24 against the live server: the endpoint
// answers an unauthenticated `initialize` (401 for OAuth), and
// `oauthRegistration` records whether the authorization server's metadata
// publishes a `registration_endpoint`. `client_required` means the workspace
// brings its own OAuth app, because the server registers no clients itself.
// Icons and docs are the vendor's own URLs. A vendor that moves an endpoint
// breaks its row here, and the wizard's authorization step says so.
import type { McpRegistryServer } from "@oxagen/oxagen/contracts/agent.mcp.registry.search";

type Verified = Pick<
  McpRegistryServer,
  | "name"
  | "description"
  | "publisher"
  | "iconUrl"
  | "websiteUrl"
  | "docsUrl"
  | "endpointUrl"
  | "auth"
  | "oauthRegistration"
> & { slug: string; keywords: readonly string[] };

const VERIFIED: readonly Verified[] = [
  {
    slug: "linear",
    name: "Linear",
    description: "Issues, projects and cycles in Linear.",
    publisher: "linear.app",
    iconUrl: "https://linear.app/favicon.ico",
    websiteUrl: "https://linear.app",
    docsUrl: "https://linear.app/docs/mcp",
    endpointUrl: "https://mcp.linear.app/mcp",
    auth: "oauth",
    oauthRegistration: "dynamic",
    keywords: ["issues", "project management", "tickets"],
  },
  {
    slug: "slack",
    name: "Slack",
    description:
      "Messages, channels, canvases and search in a Slack workspace.",
    publisher: "slack.com",
    iconUrl: "https://slack.com/favicon.ico",
    websiteUrl: "https://slack.com",
    docsUrl: "https://docs.slack.dev/ai/mcp-server",
    endpointUrl: "https://mcp.slack.com/mcp",
    auth: "oauth",
    oauthRegistration: "client_required",
    keywords: ["chat", "messages", "channels"],
  },
  {
    slug: "github",
    name: "GitHub",
    description: "Repositories, issues, pull requests and Actions on GitHub.",
    publisher: "github.com",
    iconUrl: "https://github.githubassets.com/favicons/favicon.png",
    websiteUrl: "https://github.com",
    docsUrl: "https://github.com/github/github-mcp-server",
    endpointUrl: "https://api.githubcopilot.com/mcp/",
    auth: "oauth",
    oauthRegistration: "client_required",
    keywords: ["git", "code", "pull requests", "repositories"],
  },
  {
    slug: "notion",
    name: "Notion",
    description: "Pages, databases and search in a Notion workspace.",
    publisher: "notion.so",
    iconUrl: "https://www.notion.so/images/favicon.ico",
    websiteUrl: "https://www.notion.so",
    docsUrl: "https://developers.notion.com/docs/mcp",
    endpointUrl: "https://mcp.notion.com/mcp",
    auth: "oauth",
    oauthRegistration: "dynamic",
    keywords: ["docs", "wiki", "notes"],
  },
  {
    slug: "atlassian",
    name: "Atlassian",
    description: "Jira issues and Confluence pages.",
    publisher: "atlassian.com",
    iconUrl: "https://www.atlassian.com/favicon.ico",
    websiteUrl: "https://www.atlassian.com/platform/remote-mcp-server",
    docsUrl:
      "https://support.atlassian.com/rovo/docs/getting-started-with-the-atlassian-remote-mcp-server/",
    endpointUrl: "https://mcp.atlassian.com/v1/mcp",
    auth: "oauth",
    oauthRegistration: "dynamic",
    keywords: ["jira", "confluence", "issues", "wiki"],
  },
  {
    slug: "sentry",
    name: "Sentry",
    description: "Errors, issues and releases in Sentry.",
    publisher: "sentry.io",
    iconUrl: "https://sentry.io/favicon.ico",
    websiteUrl: "https://sentry.io",
    docsUrl: "https://docs.sentry.io/product/sentry-mcp/",
    endpointUrl: "https://mcp.sentry.dev/mcp",
    auth: "oauth",
    oauthRegistration: "dynamic",
    keywords: ["errors", "monitoring", "observability"],
  },
  {
    slug: "stripe",
    name: "Stripe",
    description: "Customers, payments, invoices and the Stripe docs.",
    publisher: "stripe.com",
    iconUrl: "https://stripe.com/favicon.ico",
    websiteUrl: "https://stripe.com",
    docsUrl: "https://docs.stripe.com/mcp",
    endpointUrl: "https://mcp.stripe.com",
    auth: "oauth",
    oauthRegistration: "client_required",
    keywords: ["payments", "billing", "invoices"],
  },
  {
    slug: "asana",
    name: "Asana",
    description: "Tasks, projects and goals in Asana.",
    publisher: "asana.com",
    iconUrl: "https://asana.com/favicon.ico",
    websiteUrl: "https://asana.com",
    docsUrl: "https://developers.asana.com/docs/using-asanas-mcp-server",
    endpointUrl: "https://mcp.asana.com/v2/mcp",
    auth: "oauth",
    oauthRegistration: "client_required",
    keywords: ["tasks", "project management"],
  },
  {
    slug: "vercel",
    name: "Vercel",
    description: "Projects, deployments and logs on Vercel.",
    publisher: "vercel.com",
    iconUrl: "https://vercel.com/favicon.ico",
    websiteUrl: "https://vercel.com",
    docsUrl: "https://vercel.com/docs/mcp/vercel-mcp",
    endpointUrl: "https://mcp.vercel.com",
    auth: "oauth",
    oauthRegistration: "dynamic",
    keywords: ["deployments", "hosting"],
  },
  {
    slug: "supabase",
    name: "Supabase",
    description: "Supabase projects, databases and edge functions.",
    publisher: "supabase.com",
    iconUrl: "https://supabase.com/favicon/favicon.ico",
    websiteUrl: "https://supabase.com",
    docsUrl: "https://supabase.com/docs/guides/getting-started/mcp",
    endpointUrl: "https://mcp.supabase.com/mcp",
    auth: "oauth",
    oauthRegistration: "dynamic",
    keywords: ["postgres", "database"],
  },
  {
    slug: "neon",
    name: "Neon",
    description: "Neon Postgres projects, branches and queries.",
    publisher: "neon.com",
    iconUrl: "https://neon.com/favicon.ico",
    websiteUrl: "https://neon.com",
    docsUrl: "https://neon.com/docs/ai/neon-mcp-server",
    endpointUrl: "https://mcp.neon.tech/mcp",
    auth: "oauth",
    oauthRegistration: "dynamic",
    keywords: ["postgres", "database"],
  },
  {
    slug: "hubspot",
    name: "HubSpot",
    description: "Contacts, companies and deals in HubSpot CRM.",
    publisher: "hubspot.com",
    iconUrl:
      "https://www.hubspot.com/hubfs/HubSpot_Logos/HubSpot-Inversed-Favicon.png",
    websiteUrl: "https://www.hubspot.com",
    docsUrl: "https://developers.hubspot.com/mcp",
    endpointUrl: "https://mcp.hubspot.com",
    auth: "oauth",
    oauthRegistration: "client_required",
    keywords: ["crm", "sales", "contacts"],
  },
  {
    slug: "paypal",
    name: "PayPal",
    description: "Invoices, orders and disputes in PayPal.",
    publisher: "paypal.com",
    iconUrl: "https://www.paypal.com/favicon.ico",
    websiteUrl: "https://www.paypal.com",
    docsUrl: "https://developer.paypal.com/tools/mcp-server/",
    endpointUrl: "https://mcp.paypal.com/mcp",
    auth: "oauth",
    oauthRegistration: "dynamic",
    keywords: ["payments", "invoices"],
  },
  {
    slug: "box",
    name: "Box",
    description: "Files, folders and search in Box.",
    publisher: "box.com",
    iconUrl: "https://www.box.com/favicon.ico",
    websiteUrl: "https://www.box.com",
    docsUrl: "https://developer.box.com/guides/box-mcp/",
    endpointUrl: "https://mcp.box.com",
    auth: "oauth",
    oauthRegistration: "client_required",
    keywords: ["files", "storage", "documents"],
  },
  {
    slug: "webflow",
    name: "Webflow",
    description: "Sites, pages and CMS collections in Webflow.",
    publisher: "webflow.com",
    iconUrl: "https://webflow.com/favicon.ico",
    websiteUrl: "https://webflow.com",
    docsUrl: "https://developers.webflow.com/mcp",
    endpointUrl: "https://mcp.webflow.com/mcp",
    auth: "oauth",
    oauthRegistration: "dynamic",
    keywords: ["website", "cms"],
  },
  {
    slug: "posthog",
    name: "PostHog",
    description: "Product analytics, feature flags and experiments in PostHog.",
    publisher: "posthog.com",
    iconUrl: "https://posthog.com/favicon-32x32.png",
    websiteUrl: "https://posthog.com",
    docsUrl: "https://posthog.com/docs/model-context-protocol",
    endpointUrl: "https://mcp.posthog.com/mcp",
    auth: "oauth",
    oauthRegistration: "dynamic",
    keywords: ["analytics", "feature flags"],
  },
  {
    slug: "honeycomb",
    name: "Honeycomb",
    description: "Queries, traces and SLOs in Honeycomb.",
    publisher: "honeycomb.io",
    iconUrl: "https://www.honeycomb.io/favicon.ico",
    websiteUrl: "https://www.honeycomb.io",
    docsUrl: "https://docs.honeycomb.io/integrations/mcp/",
    endpointUrl: "https://mcp.honeycomb.io/mcp",
    auth: "oauth",
    oauthRegistration: "dynamic",
    keywords: ["observability", "tracing"],
  },
  {
    slug: "cloudflare-docs",
    name: "Cloudflare Docs",
    description: "Search Cloudflare's developer documentation.",
    publisher: "cloudflare.com",
    iconUrl: "https://www.cloudflare.com/favicon.ico",
    websiteUrl: "https://www.cloudflare.com",
    docsUrl: "https://developers.cloudflare.com/agents/model-context-protocol/",
    endpointUrl: "https://docs.mcp.cloudflare.com/mcp",
    auth: "none",
    oauthRegistration: null,
    keywords: ["documentation", "workers"],
  },
];

function toServer(row: Verified): McpRegistryServer {
  return {
    id: `verified/${row.slug}`,
    name: row.name,
    description: row.description,
    publisher: row.publisher,
    publisherVerified: true,
    source: "verified",
    version: null,
    iconUrl: row.iconUrl,
    websiteUrl: row.websiteUrl,
    docsUrl: row.docsUrl,
    repositoryUrl: null,
    endpointUrl: row.endpointUrl,
    transports: ["streamable-http"],
    auth: row.auth,
    authHeader: null,
    oauthRegistration: row.oauthRegistration,
    connectable: true,
  };
}

/** The verified entries a query matches, in list order. An empty query matches all. */
export function searchVerifiedServers(query: string): McpRegistryServer[] {
  const q = query.trim().toLowerCase();
  return VERIFIED.filter(
    (row) =>
      q === "" ||
      [row.name, row.slug, row.publisher, row.description, ...row.keywords]
        .join(" ")
        .toLowerCase()
        .includes(q),
  ).map(toServer);
}

/** Endpoint hosts the verified list covers, so a registry copy of one is not listed twice. */
export function verifiedEndpointHosts(): ReadonlySet<string> {
  return new Set(
    VERIFIED.flatMap((row) =>
      row.endpointUrl === null ? [] : [new URL(row.endpointUrl).host],
    ),
  );
}
