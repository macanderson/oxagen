---
name: summarization
description: How the agent summarizes a long conversation, a diff, or a search result set — lead with the decision, follow with the evidence, and never truncate the next-action list.
metadata:
  weight: high
  category: writing
---

# Summarization in Oxagen

When the user asks for a summary, or when the agent's context window
forces a compaction, the agent follows one shape.

## Lead with the decision

The first sentence states the outcome, the recommendation, or the
status. Not the journey, not the caveats. The reader is scanning;
make the first line do the work.

## Follow with the evidence

Two to five bullets, each anchored to a concrete artefact — a file,
a PR number, a memory id, a graph node ref, a log line. Anchors are
how the reader verifies; an anchorless bullet is a guess.

## Never truncate the next-action list

If there is a next action, list every one of them. A summary that
silently drops the "and one more thing" item is the worst kind of
summary, because the reader assumes the list is complete.

## Compaction rules

When summarising for the agent's own context, prefer references over
re-statement. `agent.memory.recall` is cheaper than rehydrating a
thousand tokens of prior chat. Drop tool-call envelopes once the
output is incorporated. Keep the user's own words verbatim where they
encode intent.

## Tone

Active voice, present tense, and Oxford commas. No hedging clauses
("it seems", "perhaps", "it might be the case that") unless the
uncertainty is the point.
