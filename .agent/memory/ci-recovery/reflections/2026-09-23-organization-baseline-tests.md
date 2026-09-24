## Self-evaluation: organization baseline tests, 2026-09-23

### What I set out to do
Keep the existing organization component checks aligned with the approved People and Invitations split.

### What I actually did
Moved invitation assertions onto their selected view, kept each view's empty and refused states, and added header coverage for the organization name, action permissions, and unread roster. No production source changed. No tests ran locally.

### Quality of my decisions
- Best decision: retained the existing row-action tests and changed their entry view, so moving a control did not erase its coverage.
- Weakest decision: started the initial branch push before dependencies were ready. Its message hook failed during installation; the next push passed after the isolated install completed.

### What I could have done better
- Inspect the hook bootstrap before pushing a fresh worktree to avoid concurrent dependency installation.
- Review page metadata and visible headings separately before assuming the page-load oracle asserted both. It asserts the title, while the new header deliberately names the organization.

### What surprised me about this codebase
The organization header needs the pending invitation IDs to distinguish a new invitation from an existing pending one. A failed roster read therefore suppresses Invite without suppressing workspace creation.

### Risks I am leaving behind
The page-load route updates belong to the integration branch. CI still owns execution of these component tests. Header action widgets retain their existing dedicated tests.

### Confidence in the result
Medium. Source paths and permission conditions were reviewed; test execution remains in CI.
