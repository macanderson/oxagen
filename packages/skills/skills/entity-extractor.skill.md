---
name: entity-extractor
description: How to extract entities from one or more text documents — read machine text or OCR an image, then use the workspace graph prompt to decide which entities are worth becoming nodes, shape them to their schemas, and hand them off for ingestion.
metadata:
  weight: high
  category: knowledge-graph
---

# Extracting entities for the knowledge graph

Load this skill to pull entities out of a document — or a batch — for the
workspace knowledge graph, whether a user asked an agent to grow the
graph or the ingestion engine handed over a document automatically.

Pulling words off a page is easy. The skill is deciding which of the many
things a document mentions are worth becoming nodes in *this* workspace —
and that judgement comes from the workspace, not from you.

## Read the graph prompt first

Every workspace exposes a **graph prompt**: which entity types (nodes) it
tracks, where each type's schema lives, and which relationships (edges)
are expected between them. Load it before the document — it is what turns
generic extraction into this workspace's extraction. If a workspace has
no graph prompt, don't invent one; ask for the ontology.

## Get the document into clean text

If the source is machine-readable, read its text directly. If it is not —
a scan, a photo, an image-only or garbled PDF — OCR it, requesting a
clearer capture rather than extracting from low-confidence noise. Confirm
the text is faithful first; mojibake and dropped columns produce phantom
entities. Preserve structure (tables, headings) — it is evidence for
relationships later.

## Identify candidates

Read for the things the graph prompt's node types describe. Pull every
plausible candidate, keeping its surface form *as written* and where it
came from (page, section, quoted line) — both are needed downstream.

## Select what is worth ingesting

This is the core of the skill. Admit a candidate only when it is:

- **Typed** — it maps to a node type the graph prompt defines. No type,
  no node; flag a recurring un-typed entity rather than inventing a type.
- **Identifiable** — you can tell which real-world thing it is, well
  enough to fill the type's identifier fields.
- **Material** — the document says something about it; it is not
  boilerplate or a passing aside.
- **Supported** — a specific span of the source backs it.

Selection criteria in the graph prompt override these defaults. Stay in
the workspace's lane.

## Shape and source each node

Conform every node to its schema — required properties present, names and
values normalized to the workspace's convention, missing fields left
unset rather than invented. Attach provenance to each: the document and
the location it came from. Never emit an unsourced node.

## Hand off

Pass the candidate nodes on for `entity-resolver` to match against the
graph, `relationship-extractor` to connect, and `graph-ingestion` to
commit. Report what you kept and what you dropped, and why.
