# agent.memory.import.parse

**Domain:** agent
**Mode:** sync (batch)
**Scope:** organization + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Accept a batch of uploaded markdown documents (skill files, runbooks, rule documentation) and use the AI gateway to extract atomic, self-contained memories from each, classifying every one into a kind and weight. This is the first half of bulk memory import—returns editable drafts without persisting anything to the graph. Callers review, edit, and confirm the drafts via `agent.memory.import.commit`.

## Access control

Requires `org.Owner` or `org.Admin`, plus `workspace.Owner` or `workspace.Member`.
Default effect: deny.

## Input

| Field             | Type                                                                    | Notes                                                      |
| ----------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------- |
| `documents`       | `Array<{ filename: string; content: string }>` (1 – 25 items)          | Markdown documents to parse. Each content ≤ 100 KB.       |
| `defaultNodeRef`  | `string?`                                                               | Optional default graph node ref for all drafted memories. |

## Output

| Field           | Type                                                                                                                 | Notes                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `drafts`        | `Array<Draft>` (see shape below)                                                                                    | Classified memory candidates, unsaved, ready for editing.  |
| `documentCount` | `number`                                                                                                             | Total documents processed (including skipped ones).        |
| `skipped`       | `Array<{ filename: string; reason: string }>`                                                                       | Documents that could not be parsed, with error reason.     |

### Draft shape

| Field             | Type                                                                          | Notes                                                                          |
| ----------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `lesson`          | `string` (1 – 2000)                                                           | The extracted memory lesson, in prose.                                        |
| `kind`            | `"routine-change" \| "constraint" \| "bug-root-cause" \| "convention-deviation" \| "gotcha"` | Memory category assigned by the AI.                                |
| `weight`          | `"low" \| "high" \| "critical"`                                               | Importance weight assigned by the AI.                                        |
| `source`          | `"user"`                                                                      | Always `"user"` for imported documents (distinguishes from agent-generated).   |
| `nodeRef`         | `string`                                                                      | Graph node ref for the memory. Defaults to `defaultNodeRef` or `"user-memory"`. |
| `sourceDocument`  | `string`                                                                      | Filename of the source document.                                              |
| `classified`      | `boolean`                                                                     | Always `true` (parsed by the AI classification pipeline).                     |

## Side effects

None—read-only. The AI parses the documents and returns drafts; nothing is written to the graph until `agent.memory.import.commit` is called.

## Errors

| code                    | meaning                                              |
| ----------------------- | ---------------------------------------------------- |
| `document_limit_exceeded` | More than 25 documents provided.                   |
| `document_size_exceeded` | A single document exceeds 100 KB.                  |
| `parse_failed`          | AI gateway failed to classify a document.           |
| `invalid_noderef`       | The provided `defaultNodeRef` is not a valid format. |
| `graph_unavailable`     | Neo4j unreachable (required for nodeRef validation).  |

## Notes

- Parsing is AI-driven; results are deterministic within a single session but may vary slightly across runs depending on model updates.
- Drafts are returned in-memory and are not persisted until explicitly committed via `agent.memory.import.commit`.
- The `lesson` field is the extractable memory; callers may edit `kind`, `weight`, and `nodeRef` before committing.
- Documents with parsing failures appear in the `skipped` list and do not generate drafts.

## SPEC references

- Agent memory import contract
- Memory weighting scheme (`oxagen-feature` skill)
