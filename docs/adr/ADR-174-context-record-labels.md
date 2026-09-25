# ADR-174: A context record is named by its label

- **Status:** Accepted
- **Date:** 2026-09-24
- **Owners:** steering
- **Related:** ADR-093 (the steering assembler), ADR-101 (four harnesses),
  #4137, #3590.

## Context

A context record had a slug (its lineage id, the file stem under
`.oxagen/rules/`), a kind, a force, and a statement. It had no name. The app
filled the gap with the statement: the record page's heading, the Records
shelf, the Library table and the related list all led with a sentence that
can run to several lines. The record's other facts (force, effect, scope,
version) sat in unlabelled chips under it, and the page had no Clone button,
though agents and skills did.

The database had carried a `label` column since `20260923233000`, filled from
the slug by a recurring job and capped at 200 characters. The record file did
not carry it, so a label set in the app never reached the repository, and
Stella could not read it.

## Decision

1. **Every record has a label, a slug, a kind, and a statement.** The label is
   the record's name on every surface: the page heading, the breadcrumb, list
   rows, and the clone editor. The statement prints under it.
2. **A label is 1 to 36 characters.** It has to fit a heading, a list row and
   a breadcrumb. The contracts, the schema check, the database constraint and
   the inputs all hold the same cap, `CONTEXT_RECORD_LABEL_MAX` in
   `packages/oxagen/src/context-record-label.ts`. `fitContextRecordLabel`
   cuts a longer one at the last word boundary that fits.
3. **The label comes first and the slug is derived from it.** The record
   wizard asks for the label and fills the slug from it. You can edit the slug
   before the record is published.
4. **A slug is unique and never changes. A label can repeat and can change.**
   A rename writes the new label into the file and changes nothing else.
5. **The label lives in the record file, outside the hash.** It sits after
   `lineage_id` in `context-record/v0.1`. `stampRecordObject` leaves it out of
   the `record_hash` preimage, so a rename is not a new version and the hash
   Oxagen computes matches the one Stella computes, since Stella's `Record`
   struct has no label field yet.
6. **A new record never takes a slug that is already held.** Two labels can
   derive the same slug, so `propose_record` takes `createOnly`. The wizard
   and Clone set it, and the store refuses a lineage that already has a record
   or a proposal with `clone_name_taken`. It also refuses a lineage whose only
   proposal was rejected. That is stricter than it needs to be, and it is the
   safe side: the other choice silently revises a record someone else wrote.
7. **A record clone is named by its label.** The draft carries `label`, capped
   at 36, and only the slug has to be free.
8. **The record page names its properties.** Kind, force, effect, scope,
   status, version, and an open change print as labelled terms. A record with
   no force on file reads "not recorded" rather than a default.

## Consequences

- A file written before this change has no label. It reads with the label the
  database holds, or the one its slug reads as, until its next revision writes
  one. The record's document title stays its lineage.
- `20260924190000_context_record_label_36.sql` cuts every stored label over 36
  characters with the same rule as `fitContextRecordLabel`, then narrows both
  checks to 1 to 36. A row the cut missed fails the new check and stops the
  migration.
- Stella needs a `label: Option<String>` on its record, outside its hash, to
  write and show labels. Until then it reads the file and ignores the field.
- A rename is not versioned. The file's git history is the record of who
  renamed a record and when.
