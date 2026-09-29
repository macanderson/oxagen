# Always-on

Your operators go home at six. Your agents do not have to. This pillar is about the hours between: the agents keep working under the rules the operator set, and the operator comes back to a report.

## Status

Mac drafted these lines on 2026-09-26. The registry holds all 85 of them in `messages/always-on/`, one line per entry. `always-on-lines.md` lists every line by set, with its status.

Three of Mac's seven worked ads are approved, and `build/build.py` renders them into `ads/` at the four house sizes, on ink and on paper:

| Ad | Headline | Subline |
|---|---|---|
| `ad-oxagen-night-shift` | Sleep tight. Your agents are on the job. | While you turn in for the night, your fleet of agents keeps working. |
| `ad-oxagen-capacity` | Agents aren't headcount. They're capacity. | Focus on traction, not tracking. |
| `ad-oxagen-driver-seat` | Stay in the driver's seat. Agents deliver the momentum. | Operators set the course, agents execute and report. |

The other four worked ads and the 78 single lines are candidates, and none ships until Mac approves it. The approved `hero-eyebrow` (**Workforce management for autonomous agents**) and `hero-headline` (**Your agents are a workforce now. Manage them like one.**) stand.

The content card `content/oxagen-always-on-*` sets the night-shift headline.

`always-on.html` in the brand kit sets every line as ads, banners, website sections, and calls to action. `build/messages.py` generates it, and its builder pairs any intro with any tagline.

## Rules

These rules come from decisions Mac has already made. They hold for every always-on line.

1. **Oxagen governs the agents and does not run them.** The agents do the overnight work. Oxagen decides what they may do, hands them what they need, and keeps the record. A line that says Oxagen executes, orchestrates, or runs the work is wrong.
2. **Every run keeps an owning operator.** Mac decided on 2026-09-25 that unattended runs do not exist. Going home hands off the hours and keeps the ownership. A line that reads as nobody being responsible needs Mac's reading.
3. **The rule decides and Oxagen applies it.** Agents do not enforce their own rules. Say "Oxagen applies them to governed calls", never "agents enforce them".
4. **The record covers governed actions.** "Every action recorded automatically" becomes "every governed action recorded automatically".
5. **Always and never describe the schedule.** "Always-on" and "agents never sleep" describe hours, which is fine. "Always moving forward" and "never idling" promise an outcome, which `words.md` warns against.
6. **Completion stays optional.** A completion record belongs to a bounded task. It never leads a line.
7. **No savings claim.** "ROI" promises a return. Pair it with a measured workload or cut it.

## Sets

| Set | Entries | Carries | Use as |
|---|---|---|---|
| `primary` | 4 | The proposed eyebrow, category, product experience, and lead | Hero and page tops |
| `value` | 7 | Why agents differ from employees | Ad intro |
| `night` | 10 | Off-hours work | Tagline |
| `reframe` | 11 | Workforce management rethought, with the momentum taglines | Intro or tagline |
| `split` | 9 | Operators steer and agents execute | Intro, with a control tagline |
| `steer` | 11 | Central steering and changes of plan | Intro or tagline |
| `coach` | 6 | Operators guide strategy | Intro or tagline |
| `vision` | 12 | Direction over process | Headline |
| `signoff` | 8 | "Oxagen, keep your agents moving." and its siblings | Closing line |
| `combos` | 7 | Mac's worked intro and tagline pairs, as full ads | Display ads |

The draft repeated eight lines under *Driving the momentum* and three sign-offs. The registry keeps one entry for each.

## Pairing

Pair an intro from `value`, `reframe`, `split`, `steer`, or `coach` with a tagline from `night`, the momentum lines in `reframe`, or the headlines in `split` and `steer`. Close with one sign-off. Mac's examples:

- **Intro.** While you turn in for the night, your fleet of agents keeps working. **Tagline.** Sleep tight. Your agents are on the job.
- **Intro.** Wake up to a progress report, not a backlog. **Tagline.** Operators sign off. Agents clock in. Progress, 24/7.
- **Intro.** Agents aren't headcount. They're capacity. **Tagline.** Focus on traction, not tracking.

One pair per ad. The action is the house action, **Explore Oxagen**, with `oxagen.sh`, and it is the one gold element on the ad.

## Open decisions

Each item below is Mac's call. The proposals are not approved lines, and the registry keeps Mac's line as drafted until Mac chooses.

| Entry | Question | Proposal |
|---|---|---|
| `always-on-eyebrow`, `workday-lead` | Replace the approved hero eyebrow and headline? | Keep the approved hero. Use these on an always-on page. |
| `control-plane-category` | Un-retire `retired-control-plane-agent-workforce` (retired 2026-09-18)? | Keep agent control plane as the technical category in body copy. |
| `dispatch-experience` | Dispatch is not a named product surface. The line also leads with completion records. | "Progress logs and records of governed actions are automatic." |
| `split-control-panel` | Control panel or the category term, agent control plane? | Agent control plane. |
| `split-disengaged` | "Disengaged" reads as unattended, against the 2026-09-25 ownership rule. | Cut it, or "Operators step away. Agents keep working." |
| `split-lead-not-labor`, `value-doing-it-wrong` | Both talk down to a reader (finding 08). | Cut, or keep for an internal audience only. |
| `steer-rules-once` | Agents do not enforce rules. | "Set the rules once. Oxagen applies them to governed calls, all night and all weekend." |
| `reframe-report-not-timesheet` | The record covers governed actions only. | "Review the report, not the timesheet. Every governed action recorded automatically." |
| `reframe-like-tools` | "ROI" is a savings claim. | Hold until a measured workload backs it. |
| `steer-redirect-fleet`, `steer-one-command` | Redirecting every agent in real time is not a shipped capability. | Hold until it ships. |
| `steer-adapt-instantly` | "Orchestrates" and "everywhere" overstate what Oxagen does. | Scope to governed calls, or cut. |
| `steer-move-with-you` | "Ensures" is a promise the record cannot back. | "Oxagen steers your agents to match your new direction." |
| `coach-always-moving` | "Always moving forward, never idling" promises an outcome. | "Your projects keep moving after you log off." |
| `ad-oxagen-progress-report` | "Progress, 24/7" promises an outcome around the clock (rule 5). | Drop that sentence. Keep "Operators sign off. Agents clock in." |
| `ad-oxagen-momentum` | `words.md` makes rule the house word and policy the word to avoid, so "No more policies" can read as no more governance. | "No more shift rotas or burnout." |
| `ad-oxagen-vision-momentum` | "Oxagen turns your vision into momentum" says Oxagen does the work (rule 1). "Moving your goals forward 24/7" promises an outcome (rule 5). | "Your agents turn your vision into momentum.", with the subline "Wherever you steer, your agents follow." |
| `ad-oxagen-live-your-life` | "Welcome to acceleration" claims a speed-up, and no measured workload backs one. | Drop that sentence. Keep "Let agents drive your progress." |

## Edits already made

The registry changed the draft in three ways, and none changes a claim.

- Every em dash became a period, a comma, or a colon.
- Every exclamation point went.
- "Effortless" left `coach-acceleration` and the ad built from it, because `words.md` bans it.
