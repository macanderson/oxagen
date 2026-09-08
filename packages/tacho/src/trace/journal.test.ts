import { describe, expect, it } from "vitest";
import {
  JournalError,
  describeJournal,
  journalFromNdjson,
  journalToNdjson,
} from "./journal";

const TWO_LINES = [
  '{"seq":1,"at":"2026-07-23T09:00:00Z","session":"sess_1","event":"session_start","agent":"example-agent","harness":"stella/0.9"}',
  '{"seq":2,"at":"2026-07-23T09:00:01Z","session":"sess_1","event":"session_end","outcome":"completed"}',
  "",
].join("\n");

describe("journal parsing", () => {
  it("parses a well-formed journal in file order and describes it", () => {
    const journal = journalFromNdjson(TWO_LINES);
    expect(journal.events).toHaveLength(2);
    expect(journal.events[0]?.seq).toBe(1);
    expect(journal.events[1]?.event).toBe("session_end");
    expect(describeJournal(journal)).toBe(
      "session sess_1 - agent example-agent (harness stella/0.9), 2 event(s)",
    );
    expect(journalToNdjson(journal)).toBe(TWO_LINES);
  });

  it("permits blank lines but names the line of any garbage", () => {
    expect(journalFromNdjson(`\n${TWO_LINES}\n`).events).toHaveLength(2);
    expect(() => journalFromNdjson(`${TWO_LINES}not json {{\n`)).toThrow(
      JournalError,
    );
    try {
      journalFromNdjson(`${TWO_LINES}not json {{\n`);
    } catch (error) {
      expect((error as JournalError).line).toBe(3);
    }
    expect(() =>
      journalFromNdjson(
        `${TWO_LINES}{"seq":3,"event":"unknown_kind","at":"x","session":"sess_1"}\n`,
      ),
    ).toThrow(JournalError);
  });

  it("treats an empty journal as an error, never a vacuous pass", () => {
    expect(() => journalFromNdjson("\n\n")).toThrow(JournalError);
  });

  it("describes a journal that does not open with session_start without the agent", () => {
    const journal = journalFromNdjson(
      '{"seq":1,"at":"2026-07-23T09:00:00Z","session":"sess_x","event":"turn_start","turn":1}\n',
    );
    expect(describeJournal(journal)).toBe("session sess_x, 1 event(s)");
  });
});
