/**
 * The status an assistant message's metadata carries when the person stopped
 * the turn (#4164). `appendAssistantMessage` writes it and `get_conversation`
 * reads it, so both import this one value. The module imports nothing, so the
 * handlers package can read it without loading the turn runtime.
 *
 * Saved rows already carry the string "stopped". Changing the value would
 * leave those rows unread, so treat it as a stored format.
 */
export const ASSISTANT_MESSAGE_STOPPED = "stopped";
