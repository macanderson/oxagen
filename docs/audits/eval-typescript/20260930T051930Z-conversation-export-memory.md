# Conversation export memory

Reviewed the conversation export handler, its SQL snapshot reader, Markdown output, and PDF renderer for issue #4202.

| Severity | Location | Issue | Status |
| --- | --- | --- | --- |
| P1 | `packages/handlers/src/conversation.export.ts` | An export loaded every message, content block, and metadata object before selecting its active branch. One large conversation could exhaust the service heap. | Fixed; CI pending |
| P1 | `packages/handlers/src/lib/conversation-pdf.ts` | PDF layout retained every page with no text, block, or page ceiling. A newline-heavy message could allocate pages until the process failed. | Fixed; CI pending |

The SQL statement reads the active leaf and up to 501 message candidates in one snapshot. PostgreSQL checks the 500-message and 2 MiB source limits before aggregating message payloads into the result. Source accounting includes every branch, role text, content, serialized content blocks, and serialized metadata. Oversized exports return flags without the large fields. Header fields have an 8 KiB limit.

Markdown output has a 4 MiB ceiling. PDF validates 128 KiB of text and 2,000 blocks before importing the renderer, then refuses page 101 before allocation. Exceeding a limit throws before asset persistence. The handler continues to export the active branch and stores successful PDFs privately without conversation linkage.

Regression coverage includes SQL execution against Postgres with rolled-back fixtures, 500/501 rows, UTF-8 metadata bytes, tenant scope, Markdown expansion, PDF text and page limits, and failure before persistence. Existing active-branch and private-asset tests remain. No build, lint, typecheck, or test ran locally under the machine's CI-only rule. Static diff whitespace validation passed.

No PR was opened by this agent. The parent owns publication and CI verification with the rest of #4202. These limits bound a single export; fleet throughput remains a separate capacity measurement.
