/**
 * Maximum steering or message text accepted by dispatch_command.
 *
 * A steer reaches the agent as hook `additionalContext`, and Claude Code keeps
 * only 10,000 characters of that: past it the text is saved to a file and the
 * model sees a preview. The collector delivers a hook's messages together
 * under 9,500 characters (`ADDITIONAL_CONTEXT_MAX_CHARS` in `@oxagen/tacho`
 * `collector/hook-handler.ts`), so one message has to fit well inside that to
 * be delivered whole.
 */
export const STEER_TEXT_MAX = 8_000;

/** Maximum pause, resume, or cancel reason accepted by dispatch_command. */
export const COMMAND_REASON_MAX = 512;
