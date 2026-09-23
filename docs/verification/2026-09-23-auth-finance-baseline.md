# Auth, onboarding and finance baseline

Source: `oxagen-roadmap` at `bf728b478fb6dc20af1c3b9febba8edf350d3d55`, served at `http://localhost:3310`. This inventory uses `docs/` and `mockups/pages/`; it excludes rev2 and future-state files. Implementation baseline: Oxagen `9b1b6fce0`. The current user requirement takes precedence over earlier scope cuts. Step 1 resurfaces existing behavior only; new backend work in the last column waits for a later phase. Proof, witness and product DoD remain paused.

| Page | Required behavior | Current backing | Work remaining |
|---|---|---|---|
| Sign up | Email/password or configured SSO, verification then organization | Better Auth and signup form | Confirm OTP handoff and full error states |
| Verify email | Six digits, ten-minute expiry, resend invalidates old code, countdown | Link verification only | Add actual OTP backend and accessible code form |
| Login | Password or SSO, preserve destination, second factor when enrolled | Better Auth and login form | Check source parity and errors |
| Two-factor | Six digits, recovery option, three wrong codes then 15-minute lockout | TOTP and recovery verification; generic request limiter | Add digit UI and account-bound failure lockout |
| Forgot/reset password | Enumeration-safe request, one-hour single-use link, revoke other sessions | Implemented in Better Auth configuration and forms | Verify rendered states and expiry contract |
| Invitation | Inviter, org/workspace role and authority, expiry, accept/decline | Invitation contracts and views | Trace workspace/repository details and declined notification |
| Organization gate | Create organization and first workspace, retain gate until first frame | Create/read/advance onboarding handlers | Verify back/cancel and scope isolation |
| Wrap | Harness and OS choices, token-bearing signed installer, supported SDK path | Host token mint and CLI enrollment only | Signed installer handoff and SDK path; show unavailable until real |
| First run | Continuously wait for enrollment/frame, host log, detected repo bind/skip | Long-poll read, host facts and repo binding | Fix refresh stopping on unchanged enrollment ID; verify auto-open |
| Spend | Findings, Tokens, Coaching, operator, agent, model, tool, waste, budgets, drills | Findings, operator/agent/tool/task/cost center, waste, budget and pricing | Add Tokens, Coaching and model backing/views; reconcile evidence details |
| Billing | Plan, contracted governed-action meter, reported meters, retention, invoices, price list | Plan, GAU bucket/rate, invoices, purchase and top-up | Add reported/retention backing; reconcile credit display with amended spec |
| Audit events | Actor classification, range/search/outcome/severity/reference, accurate summaries | Security event query/export, actor IDs and detail | Add missing recorded fields, classification, search and summaries |
| Audit incidents | Organization scope, open/critical counts, detail, assignment/open | Workspace list_incidents read exists | Organization read and incident mutations/views |
| Audit receipts | Search signed tool receipts and observed authority | Run tool-call frames | Scoped receipt query and detail/export views |
| Audit exports | Durable bundle jobs, download and offline verification | Run export exists; privacy export is different scope | Organization bundle history/create and verification surface |
| Audit keys | Key generations, coverage, KEK rotation and re-wrap progress | Crypto custody exists; no app port | Governed rotation and org key status backing |
| Audit retention | Policy read/edit, archive tiers, measured storage | Retention policy versions and get_evidence_retention | Policy mutations and actual volume accounting |

No absent value may be presented as zero, no client-attested value as observed, and no unimplemented control as a successful action. Existing billing contract prices remain authoritative while page parity is restored.
