# agent.memory.promotion.dismiss

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Durably remove a memory from the promotion-candidate queue so the next-highest
OBSERVATION takes its slot. Candidates are a derived ranked window (top ACTIVE
OBSERVATIONs by citation pressure), so without a persisted marker a dismissed
suggestion reappears on the next load. Dismissal stamps `promotion_dismissed_at`
on the node; the memory itself stays ACTIVE and recallable — only the suggestion
is silenced. See `docs/specs/two-axis-memory/DESIGN.md` §7c.

## Input

| Field      | Type      | Notes                                                                 |
| ---------- | --------- | --------------------------------------------------------------------- |
| `memoryId` | `string`  | The AgentMemory node id (not publicId) to dismiss.                    |
| `restore`  | `boolean` | Clear a previous dismissal so the memory can appear again. Default `false`. |

## Output

| Field       | Type      | Notes                                                     |
| ----------- | --------- | --------------------------------------------------------- |
| `memoryId`  | `string`  | The affected memory id.                                   |
| `dismissed` | `boolean` | True when the memory is now excluded from candidates.     |

## Side effects

- Neo4j: set (or clear on `restore`) `promotion_dismissed_at` on the `:AgentMemory` node. `listPromotionCandidates` filters `promotion_dismissed_at IS NULL`.

## SPEC references

- `docs/specs/two-axis-memory/DESIGN.md` §7c
