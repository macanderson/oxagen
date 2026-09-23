# Codex hook trust and approval recovery

Enrollment wrote Codex hooks without recording their trust. A hooks file on disk could therefore coexist with a machine that recorded no Codex hook events. The recovered implementation asks Codex for the hashes of the exact installed commands in the expected hooks file, records those keys individually, and reads them back. Missing, disabled, changed, or unreadable hooks are reported instead of counted as verified.

The app-server client completes initialization, sends the initialized notification, and waits for each response before sending the next request. This prevents a trust read from overtaking the write it is meant to verify. Unenrollment removes the matching trust records before removing their hook definitions. Other hooks are left alone.

Codex does not support PreToolUse `ask`. The client now translates that response to deny on both the daemon and local fallback paths, with a message directing the operator to approve before retrying. Claude Code retains its native ask response.

Protocol sources were checked on 2026-09-22: [Codex hooks](https://learn.chatgpt.com/docs/hooks), [app-server initialization](https://learn.chatgpt.com/docs/app-server), and the installed Codex CLI's generated HookMetadata, HooksListParams, and ConfigValueWriteParams schemas. This is source and protocol review, not a live enrollment certificate.

Recovered regressions cover trust lifecycle and CLI enrollment. Added regressions cover ordered RPC, initialization rejection, missing readback, foreign hook definitions, and both ask paths. No local test was run for this change; required CI supplies the execution results. The original dirty worktree remains intact.
