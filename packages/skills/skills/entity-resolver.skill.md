---
name: entity-resolver
description: How to decide whether an extracted entity is the same as an existing graph node, a duplicate within the batch, or genuinely new — normalize and match on stable identifiers before names, treat a false merge as worse than a false split, merge properties without losing information, and escalate the uncertain cases.
metadata:
  weight: high
  category: knowledge-graph
---

# Resolving entities to graph nodes

Load this skill to decide a candidate entity's identity against the
workspace graph — on its own, from `entity-extractor` when a match is
ambiguous, or as a stage of `graph-ingestion`. The question is always:
does the graph already have a node for this thing, and which one?

## A false merge is worse than a false split

Fusing two distinct entities into one node corrupts every fact attached
to either and is hard to undo. Creating a duplicate is recoverable by a
later merge. The errors are not symmetric — when evidence is balanced,
split and flag rather than merge.

## Normalize, then block, then match

Compare canonical forms, not raw strings: fold case and whitespace,
standardize punctuation and legal suffixes, parse identifiers (emails,
domains, tax IDs, URLs) into stable form. Narrow to a few plausible
matches of the same type, then compare those in detail — don't scan the
whole graph.

## Decide on identity, not resemblance

A shared stable identifier is near-proof of identity; a similar name is
only a hint, since distinct entities share names and one entity appears
under aliases and former names. Resolve hard cases with context — a
node's properties, its existing edges, the document's domain.

## Resolve to one of three outcomes

- **Match** — the same entity as an existing node; reference it.
- **Duplicate** — the same entity as another candidate in the batch;
  collapse them.
- **New** — confidently distinct; create it.

## Merge without losing information

When you match or collapse, reconcile rather than overwrite: keep the
fresher or more specific value, union multi-valued fields, never blank a
populated field. Keep conflicting values with their provenance and flag
them.

## Set a confidence bar and escalate below it

Above the bar, resolve. Below it, emit the candidate as needs-review with
its competing matches and the evidence — a wrong guess costs more than a
human glance. Record on each resolved node what it matched and the signal
that decided it.
