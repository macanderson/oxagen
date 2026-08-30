/**
 * Connector registry bootstrap.
 *
 * Import this module once at application startup (Inngest worker, API route,
 * MCP tool) to register all connectors with the global registry. After this
 * import, getConnector(connectorId) resolves every built-in connector imported
 * below (the count drifts — read the import list, don't trust a number).
 *
 * `example-saas` ships a schema.yaml for the plugin-schema docs but has no
 * connector implementation, so it is deliberately absent here and
 * getConnector("example-saas") throws.
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

// Custom / generic connectors
import "./custom-sql/index";
import "./custom-webhook/index";

// Re-export the full registry surface (helpers + connector types) so this
// barrel is a drop-in replacement for "./types" — the package's
// "./connectors" subpath resolves here, making registration a side effect
// of the import itself.
export * from "./types";
