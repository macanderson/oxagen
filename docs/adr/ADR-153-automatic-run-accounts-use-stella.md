# ADR-153: Automatic run accounts use Stella

Status: Accepted
Date: 2026-09-23

Runs need a useful name and a concise account of the whole recorded conversation. The previous manual summary read the first sixty steps, truncated each body, and accepted only sealed runs. It could omit a later correction or the outcome of a long run.

A durable sweep finds changed wrapped sessions and evidence-ledger runs every five minutes, including historical recordings uploaded later. Per-run batching and concurrency coalesce notifications. A digest of the recorded frames and body references skips unchanged input. Encrypted content-addressed chunks and a manifest keep transcript bytes out of durable-step payloads. Availability contributes to the input digest; unreadable bodies remain eligible for the next sweep. Separate observation timestamps prevent the summary write from scheduling itself.

Stella's existing headless engine generates these accounts through `runGovernedTurn`, with no tools. Every retained text body participates in chronological chunks. Long inputs are reduced in successive levels before a final name and summary. The model is told to treat recorded instructions as evidence, and missing bodies are disclosed. Model-written prose is a derived account, never a replacement for the recording. The full unique run ID as a suffix distinguishes otherwise identical titles.

Model selection, funding, credit admission and charging use the existing organization path. Each model step checks credit admission and is checkpointed by the durable job. An unavailable engine or refused credit admission leaves the recording intact and does not manufacture a summary.

`runEnrichmentEnabled` in workspace settings defaults to true. The existing settings capability and role gate control it. The job checks it before model calls and before publishing. Turning it off hides generated names and summaries in run reads, so the UI displays the run ID. It does not turn off Stella chat, recording, deterministic repository and output evidence, metering, or harness identity.

The schema adds nullable `summary_input_digest`, `summary_observed_at` and `summary_observed_revision` columns to both run stores. `summary_observed_revision` holds the row's `updated_at` as the enrichment read saw it, to the microsecond. The sweep compares the two exactly, so a frame append that commits after the read brings the run back even when its transaction timestamp predates the read. Deploy migration 20260923235000 before registering the new jobs. Existing runs are eligible for the initial sweep. The existing manual summarize action queues the same enrichment event; its sealed/body-retention admission remains unchanged.

The sweep processes up to five hundred rows per store per pass. A backlog takes multiple passes. Derived accounts expose their generation time. They do not claim to cover actions or messages the recorder never retained.

The previous `run.summarize.ts` implementation and its tests remain preserved. The registered `run.summarize` function now forwards queued legacy events into the Stella job. Re-enabling enrichment resets observation cursors but retains input digests, so unchanged generated accounts do not incur another charge.

Enrichment runs serialize per organization. This also excludes concurrent work on one run and bounds credit admission while historical runs catch up. Event batches use the durable adapter's five-event maximum. Model construction, runtime credentials and the credit gate use one funding snapshot per turn.

Each sweep event carries a dedup id built from the run's ID, its revision and its last observation time. A later sweep that re-selects a run whose job is still running sends the same id, and the provider drops the copy. The sweep skips archived workspaces and workspaces with enrichment turned off, and the job checks both again before any model call. An archived workspace cannot change its settings, so it is never charged for.
