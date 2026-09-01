/**
 * Connector registry bootstrap.
 *
 * Import this module once at application startup (Inngest worker, API route,
 * MCP tool) to register all connectors with the global registry. After this
 * import, getConnector(connectorId) resolves every built-in connector — the
 * import list below is the set, and BUILT_IN_PLUGIN_IDS in
 * connector-schema-loader.ts is what pairs each id with its schema.yaml.
 *
 * Connector layout:
 *   packages/ingestion/src/connectors/
 *     github/          — pull requests, issues, commits, releases (webhook)
 *     google/          — Drive, Calendar, Gmail, Meet, Tasks, Contacts, BigQuery (OAuth)
 *     zoom/            — meetings (webhook)
 *     linear/          — issues, projects, cycles, comments (webhook)
 *     slack/           — messages, channels, users (webhook)
 *     salesforce/      — opportunities, contacts, accounts, leads, cases (REST poll)
 *     microsoft/       — Outlook, Teams, SharePoint, OneDrive, Calendar (webhook + admin consent)
 *     stripe/          — customers, charges, refunds, subscriptions, invoices, disputes (REST poll)
 *     zendesk/         — tickets, ticket comments, users, organizations (incremental export poll)
 *     custom-sql/      — any database via connection string + custom queries (SQL poll)
 *     custom-webhook/  — any HTTP webhook source (generic)
 */

// GitHub
import "./github/index";

// Google Workspace
import "./google/drive";
import "./google/calendar";
import "./google/gmail";
import "./google/meet";
import "./google/tasks";
import "./google/contacts";
import "./google/bigquery";

// Zoom
import "./zoom/index";

// Linear
import "./linear/index";

// Slack
import "./slack/index";

// Salesforce
import "./salesforce/index";

// Microsoft 365
import "./microsoft/index";

// Stripe — a customer's own Stripe account as business entities, unrelated to
// packages/billing (how Oxagen bills its own customers).
import "./stripe/index";

// Zendesk
import "./zendesk/index";

// Custom / generic connectors
import "./custom-sql/index";
import "./custom-webhook/index";

// Re-export the full registry surface (helpers + connector types) so this
// barrel is a drop-in replacement for "./types" — the package's
// "./connectors" subpath resolves here, making registration a side effect
// of the import itself.
export * from "./types";
