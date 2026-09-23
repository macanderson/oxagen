# Subprocessors

Your deployment determines which parties receive data. This is a technical recipient inventory, not a signed contractual subprocessor schedule. Confirm the legal entity, contract, processing location, and transfer mechanism before attaching it to a DPA.

The baseline is named in the [pack index](README.md). A dependency alone does not establish that production sends data to its vendor.

| Recipient or operator | Data and purpose | Location evidence | Source and scope |
| --- | --- | --- | --- |
| Amazon Web Services | Application hosting, databases, artifacts, logs, backups, and secret configuration | Regional default `us-east-1`. CDN delivery is global. | [Active stack](../../infra/stacks-new/oxagen/variables.tf), [data services](../../infra/stacks-new/oxagen/data-services.tf), [logs](../../infra/stacks-new/oxagen/observability.tf). Verify deployed configuration. |
| Stripe | Billing identity, payment references, invoices, and payment processing | Processing region and contractual entity not established by source | [Stripe provider](../../packages/billing/src/stripe-provider.ts). Payment card collection and processor scope require deployment review. |
| OpenRouter and selected downstream model providers | Prompts, model inputs, responses, and usage where that route is selected | Provider and route dependent. No residency promise established here. | [Platform selection](../../packages/ai/src/platform-provider.ts), [model routing](../../packages/ai/src/models.ts). Enumerate the actual downstream models in the customer schedule. |
| Vercel AI Gateway and its selected model providers | Model and embedding payloads when configured | Contract and route dependent, unverified | [Models](../../packages/ai/src/models.ts), [embedding](../../packages/ai/src/embed.ts). Not every deployment uses this route. |
| Direct OpenAI, Anthropic, and customer-selected OpenAI-compatible endpoints | Prompts, responses, and usage sent directly by the selected BYOK route | Vendor, endpoint, legal entity, and transfer terms must be confirmed for each configured route | [BYOK client selection](../../packages/ai/src/models.ts). These direct routes bypass OpenRouter and Vercel AI Gateway. A customer-supplied endpoint can add another operator to the schedule. |
| Vercel Blob | Binary assets and evidence if the Blob adapter is selected | Bucket-specific, unverified | [Storage selection](../../packages/storage/src/client.ts), [Blob adapter](../../packages/storage/src/vercel-blob.ts). Filesystem storage does not send these objects to Vercel. |
| Configured SMTP operator | Recipient email, transactional message content, and delivery metadata | Depends on `SMTP_HOST`, unverified | [Transport](../../packages/notifications/src/transport.ts). Test fixtures naming Resend do not prove a production contract. |
| Inngest hosting operator | Durable-job event payloads and job results | Depends on the deployed Inngest endpoint, unverified | [Client](../../packages/inngest-functions/src/inngest.ts). Establish whether the endpoint is self-operated or vendor-hosted. |
| GitHub | Repository contents, configuration PRs, installation metadata, and development CI | GitHub contract and repository configuration, unverified | [GitHub package](../../packages/github/src/app-auth.ts), [CI](../../.github/workflows/pipeline.yml). Runtime repository access follows the customer's connection. |
| Attio when CRM sync is configured | Website lead contact details and submitted message | Contract and workspace location unverified | [CRM sync](../../apps/api/src/lib/cms/crm-sync.ts), [Attio client](../../apps/api/src/lib/cms/attio.ts). Marketing processing needs its own role and consent review. |
| Configured OpenTelemetry collector operator | Trace attributes including tenant identifiers and potentially caller-derived error messages | Depends on `OTEL_EXPORTER_OTLP_ENDPOINT`, unverified | [Tracer](../../packages/telemetry/src/tracer.ts). Inventory the deployed collector endpoint, operator, downstream recipients, and retention when configured. |
| Configured alert webhook operator | Error messages and request identifiers sent to a Slack-compatible endpoint | Depends on `ALERT_WEBHOOK_URL`, unverified | [Error reporting](../../packages/telemetry/src/error-reporting.ts). Inventory the deployed destination and its operator separately from customer connectors. |
| Customer-selected OAuth and connector providers | Data selected for connected workflows | Provider-specific, unverified | [Plugin credentials](../../packages/plugins/src/credentials/workspace-credential.ts), [ingestion pipeline](../../packages/ingestion/src/pipeline.ts). Inventory enabled connections before contracting. |
| Neo4j and ClickHouse hosting operators | Graph records and append-only telemetry | Active infrastructure hosts these stores on AWS. Dedicated customer endpoints can differ. | [App-node services](../../infra/modules/app-node/user-data.sh.tftpl), [data planes](../../packages/tenancy/src/data-plane.ts). Using their software does not itself make the software vendor a recipient. |

## Contract schedule

For each enabled recipient, record its legal name, address, purpose, data categories, countries, retention terms, signed DPA, onward recipients, and change-notice contact. Mark disabled routes as disabled. Do not replace an unknown region with a provider's headquarters.

The [draft DPA](dpa-template.md) requires this inventory to be completed and approved before signature. Model-provider routing and BYOK change who receives payloads, but do not remove that review.
