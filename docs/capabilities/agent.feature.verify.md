# agent.feature.verify

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low
**Requires approval:** no

## Intent

Close the loop on "is the feature actually built?" by delegating verification
to an **independent cross-vendor vision model**. After a code agent drives the
durable-sandbox browser and captures screenshots of the success state via
`browser.screenshot`, it calls this capability with the original requirement
and the asset keys. An independent judge — deliberately chosen from a
**different vendor** than the builder — reads the actual pixels and returns a
structured `pass / fail / inconclusive` verdict.

The judge never sees the builder's reasoning; it only receives the requirement,
the screenshots, and an optional checklist. A feature that merely *claims* to
work but does not render correctly is caught here, not shipped.

## Input

| Field            | Type        | Required | Notes                                                                                                                                      |
| ---------------- | ----------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `requirement`    | `string`    | yes      | What the feature should do / show — the spec the judge holds screenshots against. Max 8000 chars.                                          |
| `screenshotKeys` | `string[]`  | yes      | Private asset keys from `browser.screenshot`. 1–8 keys.                                                                                   |
| `builderModel`   | `string?`   | no       | Gateway model id of the agent that built the feature (e.g. `anthropic/claude-opus-4.8`). Forces the judge to a different vendor.           |
| `checklist`      | `string[]?` | no       | Explicit things the judge must confirm are visible or working in the screenshots. Max 20 items.                                            |

## Output

| Field          | Type                                 | Notes                                                          |
| -------------- | ------------------------------------ | -------------------------------------------------------------- |
| `verdict`      | `"pass" \| "fail" \| "inconclusive"` | `"pass"` only when screenshots clearly satisfy the requirement. |
| `confidence`   | `number` (0–1)                       | Judge's confidence in the verdict.                             |
| `judgeModel`   | `string`                             | The independent model that rendered the verdict.               |
| `builderModel` | `string \| null`                     | The builder model excluded from judging, if provided.          |
| `observations` | `string[]`                           | What the judge actually saw in the screenshots.                |
| `issues`       | `string[]`                           | Missing or broken elements blocking a pass.                    |
| `reasoning`    | `string`                             | The judge's justification for the verdict.                     |

## API

```
POST /v1/{org}/{workspace}/agent/feature/verify
Content-Type: application/json

{
  "requirement": "The login page renders a form with email and password fields and a submit button",
  "screenshotKeys": ["asset_01abc...", "asset_01def..."],
  "builderModel": "anthropic/claude-opus-4.8",
  "checklist": ["Email field is visible", "Password field is visible", "Submit button is present"]
}
```

Response:

```json
{
  "verdict": "pass",
  "confidence": 0.97,
  "judgeModel": "google/gemini-2.5-pro",
  "builderModel": "anthropic/claude-opus-4.8",
  "observations": [
    "Email input field is visible at the top of the form",
    "Password input field is visible below the email field",
    "Submit button labelled 'Sign in' is present"
  ],
  "issues": [],
  "reasoning": "All three checklist items are clearly visible in the screenshots. The form matches the stated requirement."
}
```

## MCP

Tool name: `agent.feature.verify`

## Notes

- Pair with `browser.screenshot` to capture the success state before calling the judge.
- The judge is **forced to a different vendor** than the builder when `builderModel` is provided — this prevents a model from rubber-stamping its own output.
- `"inconclusive"` is returned when screenshots are too small, blurred, or do not show enough of the feature to make a determination.
- Screenshot quality matters: use a full-page screenshot and crop to the relevant element for best judge accuracy.
- Typical workflow: `browser.navigate` → `browser.screenshot` → `agent.feature.verify`.
