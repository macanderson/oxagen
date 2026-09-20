# ADR-130: Spend and operator feedback lead the app

Status: Accepted
Date: 2026-09-20

## Context

The production Fleet table compresses agent identities into tall columns and gives raw identifiers more space than readable labels. The canonical roadmap mockup has compact tables, bounded identity labels, flat panels, and consistent page spacing. Its completion and scoring features are outside the maintainer's current product scope.

## Decision

Use the layout and data presentation in `macanderson/roadmap`'s `mockups/missioncontrol.html` across the app. The maintainer's exclusions take precedence over its contents: do not display definition of done, witness, proof, credit scores, or trust scores. Keep their stored records and contracts intact. Ordinary billing credits remain money balances, not scores.

Lead with attributed spend and recorded behavior. A finding names the affected calls, its observation window, pricing basis, recommended correction, and estimated avoidable cost. Missing costs remain missing. Do not sum different currencies into one figure. An alternative workload estimate is not a realized saving, and it does not include implementation cost unless that cost has been estimated separately with assumptions.

Offer two correction paths:

- A context PR begins in the existing context-record wizard with the finding and recommendation in its editable description. The operator reviews it before the existing proposal and PR actions run.
- A code change begins as an editable request to Stella. The request asks for a minimal correction, tests, and an implementation estimate with assumptions. Whether Stella can open a PR depends on its available repository tools and access. Opening the composer does not send a turn or create a PR.

Neither draft marks a finding fixed. Preserve existing unsent assistant text and keep assistant requests scoped to their workspace.

## Consequences

The shared page frame, table recipes, phone cards, and identity component carry the presentation across routes. Fleet and Run omit the excluded columns and sections. Spend separates recorded spend from potential savings and exposes the correction paths. Billing omits completion-only meters.

This decision changes product presentation and the recommendation handoff. It does not establish that production usage capture works, add new behavior detectors, calculate realized savings, or supply repository write tools to Stella. Each of those requires its own verification. Page-by-page browser comparison remains the check for visual fidelity; passing component tests alone cannot establish it.
