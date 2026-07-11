//! Minimal, dependency-free Server-Sent-Events line parser shared by every
//! streaming adapter. Retiring "raw SSE parsing quality" as a Phase 0 risk
//! (`03-plan.md`) means this parser is unit-tested against the exact
//! chunking pathologies a real HTTP stream produces: a `data:` line split
//! across two reads, multiple events in one read, and a trailing partial
//! line held over to the next chunk.

/// One parsed SSE event: the concatenation of every `data:` line in the
/// event, newline-joined (per the SSE spec), plus the event name if the
/// stream sent one via `event:`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
}

/// Incremental SSE decoder: feed it raw bytes as they arrive over the wire
/// (`push`), drain complete events (`poll`). Handles partial lines and
/// partial events split across arbitrary chunk boundaries.
#[derive(Debug, Default)]
pub struct SseDecoder {
    buf: String,
}

impl SseDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed a chunk of UTF-8 text (callers decode bytes -> `&str`
    /// themselves; the wire is always UTF-8 for every adapter here).
    pub fn push(&mut self, chunk: &str) {
        self.buf.push_str(chunk);
    }

    /// Drain every complete event currently buffered. An event is complete
    /// once a blank line (`\n\n`) terminates it; anything after the last
    /// blank line stays buffered for the next `push`.
    pub fn poll(&mut self) -> Vec<SseEvent> {
        let mut events = Vec::new();
        while let Some(boundary) = self.buf.find("\n\n") {
            let raw_event = self.buf[..boundary].to_string();
            self.buf.drain(..boundary + 2);
            if raw_event.trim().is_empty() {
                continue;
            }
            events.push(parse_event(&raw_event));
        }
        events
    }
}

fn parse_event(raw: &str) -> SseEvent {
    let mut event = SseEvent::default();
    let mut data_lines: Vec<&str> = Vec::new();
    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("data:") {
            data_lines.push(rest.strip_prefix(' ').unwrap_or(rest));
        } else if let Some(rest) = line.strip_prefix("event:") {
            event.event = Some(rest.strip_prefix(' ').unwrap_or(rest).to_string());
        }
        // `id:` and `retry:` fields are accepted-but-ignored: no adapter
        // here needs replay-id resumption yet.
    }
    event.data = data_lines.join("\n");
    event
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_one_complete_event_in_a_single_push() {
        let mut decoder = SseDecoder::new();
        decoder.push("event: message\ndata: {\"hello\":true}\n\n");
        let events = decoder.poll();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event, Some("message".into()));
        assert_eq!(events[0].data, "{\"hello\":true}");
    }

    #[test]
    fn handles_a_data_line_split_across_two_pushes() {
        let mut decoder = SseDecoder::new();
        decoder.push("data: {\"partial\":");
        assert!(decoder.poll().is_empty(), "no complete event yet");
        decoder.push("true}\n\n");
        let events = decoder.poll();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "{\"partial\":true}");
    }

    #[test]
    fn handles_multiple_events_in_one_push() {
        let mut decoder = SseDecoder::new();
        decoder.push("data: one\n\ndata: two\n\ndata: three\n\n");
        let events = decoder.poll();
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].data, "one");
        assert_eq!(events[1].data, "two");
        assert_eq!(events[2].data, "three");
    }

    #[test]
    fn holds_a_trailing_partial_event_for_the_next_poll() {
        let mut decoder = SseDecoder::new();
        decoder.push("data: complete\n\ndata: incomplete");
        let events = decoder.poll();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "complete");
        decoder.push(" now\n\n");
        let events = decoder.poll();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "incomplete now");
    }

    #[test]
    fn joins_multiline_data_fields_with_newlines_per_sse_spec() {
        let mut decoder = SseDecoder::new();
        decoder.push("data: line one\ndata: line two\n\n");
        let events = decoder.poll();
        assert_eq!(events[0].data, "line one\nline two");
    }

    #[test]
    fn ignores_blank_events_between_boundaries() {
        let mut decoder = SseDecoder::new();
        decoder.push("\n\ndata: real\n\n");
        let events = decoder.poll();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "real");
    }
}
