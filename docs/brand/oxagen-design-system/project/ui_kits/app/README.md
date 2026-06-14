# Oxagen App — UI kit

A click-through recreation of the Oxagen product, built from `app/` (the Next.js
app) and `@oxagen/ui`. Open `index.html`.

### Flow
1. **Login** (`LoginScreen.jsx`) — branded auth on the `.ox-mesh` deep-space
   background; OAuth + email. "Sign in" enters the app.
2. **Ask** (`AskScreen.jsx`) — the agent chat: user/assistant bubbles, a
   reasoning + tool-call timeline (`graph.query`, low-risk, with `NodeChip`
   results), and the composer (model picker, reasoning effort, image/video
   toggles, MCP, gradient Send). Sending a message appends a scoped reply.
3. **Knowledge → Graph** (`KnowledgeScreen.jsx`) — stat row, an SVG knowledge-
   graph canvas (typed glowing nodes + edges over `.ox-grid-dots`), and the
   pending-inference review panel (`NodeChip` → relationship → `NodeChip`,
   `ConfidenceBar`, Approve/Deny).
4. **Access** (`AccessScreen.jsx`) — the RBAC role builder: the 5 system roles
   (Owner/Admin/Billing/Member/Viewer) + a custom-role tile, each with a
   permission matrix.

### Structure
| File | Role |
|---|---|
| `index.html` | Loads React UMD + Babel + Lucide + `_ds_bundle.js`, then the JSX files. |
| `icons.jsx` | `Icon` — Lucide icon (currentColor) helper → `window.Icon`. |
| `Shell.jsx` | Floating sidebar + content panel chrome → `window.Shell`. |
| `LoginScreen.jsx` / `AskScreen.jsx` / `KnowledgeScreen.jsx` / `AccessScreen.jsx` | Screens. |
| `App.jsx` | Auth gate + nav state machine; mounts `#root`. |

Components come from the DS bundle (`Button`, `Badge`, `Card`, `Input`,
`Textarea`, `Tabs`, `Avatar`, `OxagenLogo`, `NodeChip`, `ConfidenceBar`) — the
kit composes them rather than re-implementing primitives.

> Recreation, not production code: data is mocked and interactions are
> cosmetic. Visual fidelity (layout, color, type, iconography) is the goal.
