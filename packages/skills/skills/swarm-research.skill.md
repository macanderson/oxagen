---
name: swarm-research
description: How to run a multi-agent research swarm — decompose a question, fan out independent searchers in parallel, adversarially verify every claim before trusting it, and synthesize a cited answer — so breadth and confidence come from parallelism, not one long serial pass.
metadata:
  weight: high
  category: research
---

# Running a research swarm

Load this skill when a question is too broad, too deep, or too
consequential for a single pass — you want many agents covering ground in
parallel and checking each other, then one synthesis you can trust. The
value of a swarm is not speed alone; it is that independent perspectives
catch what one context misses, and that claims survive scrutiny before
they reach the answer.

## Decompose before you dispatch

Split the question into independent sub-questions that can be researched
without waiting on each other. Good sub-questions have little overlap and
together cover the whole question. If two sub-questions must share a
finding to proceed, they are not independent — sequence those, and
parallelize the rest. A clean decomposition is what makes fan-out worth
the coordination cost.

## Fan out independent searchers

Give each searcher one sub-question and a distinct angle, and run them
concurrently. Diversity beats redundancy: a searcher looking by source
type, one by entity, one by timeline, and one by counter-evidence will
surface more than four searchers running the same query. Each works blind
to the others so their findings are genuinely independent, not echoes.

## Make every finding carry its evidence

A finding with no source is a guess. Require each searcher to return
claims paired with where the claim came from and how strongly the source
supports it. Prefer primary sources over summaries, and record the date —
facts have validity windows, and a true-last-year claim can be false
today. Unsourced assertions are dropped, not promoted.

## Verify adversarially before you trust

Do not accept a claim because it sounds right. Spawn verifiers whose job
is to *refute* each material claim — find the contradicting source, the
missing caveat, the newer fact that supersedes it. When a claim can fail
in more than one way, give verifiers different lenses rather than the same
skeptical prompt repeated. A claim earns a place in the answer only after
it survives a genuine attempt to break it; when verifiers disagree, that
disagreement is itself a finding worth reporting.

## Deduplicate and reconcile

Findings from independent searchers overlap and sometimes conflict.
Merge duplicates, and when two sources disagree, surface the conflict and
weigh it — recency, source quality, corroboration — rather than silently
picking one. A contradiction you resolve on the record is more useful
than a confident answer that hid it.

## Synthesize with citations, and name the gaps

Write the answer from the verified, deduplicated findings, and cite each
non-obvious claim so a reader can check it. State confidence honestly:
separate what is well-supported from what is thin or contested. End by
naming what remains unknown — the source you could not reach, the angle
you did not run — because an honest gap is worth more than a fabricated
certainty, and it tells the next swarm where to start.

## Loop until the returns dry up

For open-ended discovery, one round rarely finds everything. Run another
round of searchers on the gaps and unresolved conflicts; stop when
consecutive rounds surface nothing new, not when you hit an arbitrary
count. If you bound the effort for cost, say what you capped and what was
left uncovered — a silent cap reads as "we covered everything" when you
did not.
