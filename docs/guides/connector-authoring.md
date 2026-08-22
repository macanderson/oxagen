# Connector Authoring Guide

This guide explains how to author an Oxagen connector schema as a partner or
third-party developer. A connector schema is a YAML file that describes your
platform's authentication options, configuration fields, and entity types.
Oxagen fetches this file at install time, renders a dynamic
form from it, and routes synced data through the knowledge-graph pipeline.

No code deployment is required. Your connector is fully described by a single
YAML file hosted at a stable HTTPS URL.

---

## Overview

The connector schema system is built around the `ConnectorPlugin` resource
kind. When a user installs your connector via the Oxagen UI or agent, the
platform:

1. Fetches your `schema.yaml` from the URL you registered.
2. Parses and validates it against the `ConnectorPluginSchema` interface.
3. Caches the schema in the `ingestion.connector_schemas` database table.
4. Renders a dynamic form using the schema's `auth`, `config`, `recordTypes`,
   `filters`, and `sync` sections.
5. Stores the user's submitted config and begins the ingestion pipeline.

Built-in connectors (GitHub, Google Drive, Slack, Linear) ship as bundled YAML
files in the Oxagen monorepo and serve as the reference implementation. Your
partner connector follows the same schema format — the platform treats both
identically after loading.

---

## Schema structure

A complete connector schema has the following top-level sections:

```
apiVersion    (required)
kind          (required)
metadata      (required)
auth          (required unless kind: none)
config        (optional — platform-specific settings)
recordTypes   (optional — entity types your connector produces)
filters       (optional — path and label filtering)
sync          (required)
defaultFieldMappings (optional — API field → graph property mapping)
```

### `apiVersion` and `kind`

```yaml
apiVersion: oxagen.ai/v1alpha1
kind: ConnectorPlugin
```

Both fields are required and must be exactly these values. `apiVersion` will
increment when breaking schema changes are introduced; old versions remain
supported for a migration window.

---

### `metadata`

```yaml
metadata:
  id: my-platform          # globally unique, kebab-case, immutable after registration
  displayName: My Platform
  description: One or two sentences describing what data this connector syncs.
  icon: my-platform        # icon slug for marketplace display
  category: crm            # marketplace category (see list below)
  version: "1.0.0"         # semantic version of your connector logic
  schemaVersion: "1"       # schema format version — always "1" for now
  publisher:
    name: My Company Inc.
    verified: false        # Oxagen sets this to true after review
```

**`id`** must be globally unique across all connectors, built-in and partner.
Choose `{your-company}-{platform}` to avoid collisions (e.g. `acme-jira`).
Once a connector is registered, the ID cannot change.

**`category`** values: `developer-tools`, `project-management`, `communication`,
`productivity`, `crm`, `analytics`, `finance`, `security`, `hr`.

---

### `auth`

Describe how Oxagen authenticates with your platform.

```yaml
auth:
  schemes:
    - id: oauth2
      kind: oauth2_authorization_code
      displayName: Connect with My Platform (OAuth)
      scopes:
        - read:accounts
        - read:events

    - id: api_key
      kind: api_key
      displayName: API Key
      fields:
        - key: apiKey
          label: API Key
          widget: secret
          description: Generate at app.myplatform.com/settings/api-keys.
          validation:
            required: true
            pattern: "^mypfx_[A-Za-z0-9]{32,}$"
```

**Auth scheme kinds:**

| Kind | Description |
|---|---|
| `oauth2_authorization_code` | Standard OAuth 2.0 browser redirect flow |
| `oauth2_client_credentials` | Machine-to-machine OAuth 2.0 (no user redirect) |
| `api_key` | Static token sent as a header or query param |
| `basic` | HTTP Basic (username + password) |
| `none` | No authentication (public data source) |

For `api_key` and `basic`, you must define `fields` to collect the credential
values. Credential fields are encrypted at rest using `@oxagen/crypto` before
storage; they are never returned in API responses.

---

### `config`

Config fields are the platform-specific settings a user fills in at install
time (not credentials). They appear in the "Configuration" section of the form.

```yaml
config:
  fields:
    - key: accountId
      label: Account ID
      widget: text
      description: Your platform account identifier.
      validation:
        required: true
        pattern: "^[a-z0-9-]{2,63}$"

    - key: syncDepthDays
      label: Initial Sync Depth (days)
      widget: number
      defaultValue: 90
      validation:
        min: 7
        max: 365
```

#### Field widget types

All 13 supported widget types:

| Widget | Input type | Validation keys available |
|---|---|---|
| `text` | Single-line string | `required`, `pattern` |
| `email` | Email string | `required`, `pattern` |
| `url` | HTTPS URL string | `required`, `pattern` |
| `secret` | Masked password input | `required`, `pattern` |
| `number` | Integer or decimal | `required`, `min`, `max` |
| `textarea` | Multi-line string | `required` |
| `select` | Single value from `options` | `required`, `oneOf` |
| `multi-select` | Multiple values from `options` | `required`, `minItems`, `maxItems` |
| `tag-input` | Free-form list of strings | `minItems`, `maxItems`, `itemPattern` |
| `checkbox` | Boolean toggle | — |
| `slider` | Number within range | `min`, `max` |
| `key-value` | List of `{key, value}` pairs | — |
| `secret-file` | File upload (PEM cert, private key) | `required` |

For `select` and `multi-select`, provide an `options` array:

```yaml
- key: region
  label: Region
  widget: select
  options:
    - label: US East
      value: us-east-1
    - label: EU West
      value: eu-west-1
  validation:
    required: true
    oneOf:
      - us-east-1
      - eu-west-1
```

For `tag-input`, `itemPattern` validates each individual item in the list:

```yaml
- key: projectSlugs
  label: Projects
  widget: tag-input
  validation:
    minItems: 1
    itemPattern: "^[a-z0-9-]{1,50}$"
```

---

### `recordTypes`

List every entity type your connector produces. These IDs are stored in
customer configs and database mappings — they must never change after
deployment.

```yaml
recordTypes:
  selectionMode: multi    # "multi" (any subset) or "single" (only one)
  defaultAll: false       # true = pre-select all; false = show checkboxes
  items:
    - id: account
      displayName: Accounts
      description: Company or organization accounts.
      defaultEnabled: true

    - id: event
      displayName: Events
      description: Product behavioral events.
      defaultEnabled: false
```

Use `defaultEnabled: true` only for high-value types. Users can always
deselect; start conservative to avoid over-syncing.

---

### `filters`

Filters let users narrow what gets synced after install.

```yaml
filters:
  pathFilters:
    enabled: true
    defaultIgnore:
      - "/internal/**"
      - "/debug/**"
    appliesTo:
      - event

  labelFilters:
    enabled: true
    appliesTo:
      - account
      - user
```

**`pathFilters`** applies glob patterns to record paths or identifiers. Use
`defaultIgnore` to auto-exclude noisy or sensitive paths.

**`labelFilters`** lets users exclude records by label. Set `appliesTo` to the
record type IDs where label filtering is meaningful.

---

### `sync`

```yaml
sync:
  delivery: polling         # "polling" | "webhook" | "manual"
  pollingSupported: true
  polling:
    defaultIntervalSeconds: 600
    minIntervalSeconds: 300
    maxIntervalSeconds: 86400
  webhookEvents:            # only needed when delivery: webhook
    - account.created
    - user.updated
```

Use `delivery: polling` unless your platform supports webhook push delivery.
Use `delivery: manual` for sources where sync is triggered by the user or agent.

---

### `defaultFieldMappings`

Map your API's field names to Oxagen's canonical graph node properties.

```yaml
defaultFieldMappings:
  account:
    name: title
    description: description
    domain: sourceUrl
    createdAt: createdAt
  user:
    email: email
    fullName: displayName
    companyId: parentId
```

Common Oxagen graph properties: `title`, `description`, `author`, `status`,
`tags`, `sourceUrl`, `createdAt`, `updatedAt`, `externalKey`, `email`,
`displayName`, `parentId`.

---

## Example walkthrough — Jira connector schema

This section builds a minimal Jira connector schema step by step.

**Step 1: Metadata**

```yaml
apiVersion: oxagen.ai/v1alpha1
kind: ConnectorPlugin
metadata:
  id: acme-jira
  displayName: Jira
  description: Sync issues, sprints, and epics from Jira Cloud.
  icon: jira
  category: project-management
  version: "1.0.0"
  schemaVersion: "1"
  publisher:
    name: Acme Corp
    verified: false
```

**Step 2: Authentication**

Jira Cloud supports both OAuth 2.0 (preferred) and API token (email + key):

```yaml
auth:
  schemes:
    - id: oauth2
      kind: oauth2_authorization_code
      displayName: Connect with Atlassian (OAuth)
      scopes:
        - read:jira-work
        - read:jira-user

    - id: api_token
      kind: api_key
      displayName: API Token
      fields:
        - key: email
          label: Email Address
          widget: email
          validation:
            required: true
            pattern: "^[^@]+@[^@]+\\.[^@]+$"
        - key: apiKey
          label: API Token
          widget: secret
          description: Generate at id.atlassian.com/manage-profile/security/api-tokens.
          validation:
            required: true
```

**Step 3: Config fields**

```yaml
config:
  fields:
    - key: cloudId
      label: Cloud ID
      widget: text
      description: Your Atlassian Cloud ID (found in your Jira URL).
      validation:
        required: true
        pattern: "^[a-zA-Z0-9-]{8,}$"

    - key: projectKeys
      label: Projects
      widget: tag-input
      description: Jira project keys to sync (e.g. OXA, PLATFORM). Leave empty for all.
      validation:
        itemPattern: "^[A-Z][A-Z0-9_]{0,9}$"

    - key: syncDepthDays
      label: Initial Sync Depth (days)
      widget: number
      defaultValue: 90
      validation:
        min: 1
        max: 730
```

**Step 4: Record types**

```yaml
recordTypes:
  selectionMode: multi
  defaultAll: false
  items:
    - id: issue
      displayName: Issues
      description: Bugs, tasks, stories, and subtasks tracked in Jira.
      defaultEnabled: true
    - id: epic
      displayName: Epics
      description: Large bodies of work grouping related issues.
      defaultEnabled: true
    - id: sprint
      displayName: Sprints
      description: Time-boxed sprint metadata and completion metrics.
      defaultEnabled: false
```

**Step 5: Sync config**

```yaml
sync:
  delivery: polling
  pollingSupported: true
  polling:
    defaultIntervalSeconds: 900
    minIntervalSeconds: 300
    maxIntervalSeconds: 86400
```

---

## Validation patterns

Common regular expression patterns for config field validation:

| Use case | Pattern |
|---|---|
| Email address | `^[^@]+@[^@]+\.[^@]+$` |
| HTTPS URL | `^https://[a-zA-Z0-9][a-zA-Z0-9.\-]+(/.*)? $` |
| GitHub org slug | `^[a-zA-Z0-9][a-zA-Z0-9\-]{0,38}$` |
| GitHub PAT | `^(ghp_\|github_pat_)[A-Za-z0-9_]{20,}$` |
| UUID | `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` |
| Semver | `^\d+\.\d+\.\d+$` |
| Lowercase slug | `^[a-z][a-z0-9\-]{0,62}$` |
| Jira project key | `^[A-Z][A-Z0-9_]{0,9}$` |
| AWS region | `^(us\|eu\|ap\|sa\|ca\|me\|af)-[a-z]+-\d$` |
| ISO 8601 date | `^\d{4}-\d{2}-\d{2}$` |

---

## Testing your schema locally

Before registering your schema URL, validate it locally:

**1. Parse check** — ensure the YAML is valid:
```bash
npx js-yaml your-schema.yaml
```

**2. Structure check** — load it via the Oxagen loader (requires Node.js):
```bash
node -e "
  import('yaml').then(({ parse }) => {
    const fs = require('fs');
    const parsed = parse(fs.readFileSync('your-schema.yaml', 'utf-8'));
    console.assert(parsed.apiVersion === 'oxagen.ai/v1alpha1');
    console.assert(parsed.kind === 'ConnectorPlugin');
    console.assert(parsed.metadata?.id);
    console.log('Schema is valid:', parsed.metadata.displayName);
  });
"
```

**3. Dev server test** — run the Oxagen monorepo locally and install your
connector via the UI:
```bash
pnpm dev
# Navigate to http://localhost:3000/{org}/{ws}/integrations/install
# Select "Partner Connector" tab, enter your schema URL
```

**4. API test** — call `plugin.schema.get` directly:
```bash
curl -s "http://localhost:4000/v1/{org}/{ws}/plugins/your-plugin-id/schema" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

## Submission

Once your schema is validated and hosted:

1. Host your `schema.yaml` at a stable HTTPS URL (your CDN, GitHub raw, or
   your own domain).
2. Read `docs/guides/partner-registration.md` for the registration workflow.
3. Submit your schema URL, plugin ID, and contact information to
   `partners@oxagen.ai`.
4. Oxagen will review your schema for security, quality, and compliance.
5. After approval, `metadata.publisher.verified` is set to `true` and your
   connector appears in the marketplace.

---

## Reference: complete ExampleSaaS schema

A fully annotated reference schema is available at:

```
packages/ingestion/src/connectors/example-saas/schema.yaml
```

It demonstrates all sections, field types, and validation patterns with
detailed inline comments explaining every field.
