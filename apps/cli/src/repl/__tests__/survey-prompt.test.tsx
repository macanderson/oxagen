import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { SurveyPrompt, SURVEY_DISMISS_ANSWER } from "../survey-prompt.js";
import type { AskUserResponse } from "@oxagen/agent-engine";

const ESC = String.fromCharCode(27);
const ARROW_DOWN = `${ESC}[B`;
const ARROW_UP = `${ESC}[A`;

/** Poll until `cond` holds — Ink delivers stdin/state asynchronously (never fixed sleeps). */
async function until(
  cond: () => boolean,
  timeoutMs = 4000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline)
      throw new Error("until(): condition not met before deadline");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

const QUESTION = "Which database should the new service use?";
const OPTIONS = ["Postgres", "SQLite"];

describe("SurveyPrompt", () => {
  it("renders the question, every option, and the free-text row", () => {
    const { lastFrame } = render(
      <SurveyPrompt
        question={QUESTION}
        options={OPTIONS}
        onAnswer={() => {}}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain(QUESTION);
    expect(frame).toContain("Postgres");
    expect(frame).toContain("SQLite");
    expect(frame).toContain("Other (type your own)");
    expect(frame).toContain("↑↓ select");
  });

  it("Enter on the first (default-selected) option answers with it, not free-text", async () => {
    let answer: AskUserResponse | undefined;
    const onAnswer = vi.fn((a: AskUserResponse) => {
      answer = a;
    });
    const { stdin } = render(
      <SurveyPrompt
        question={QUESTION}
        options={OPTIONS}
        onAnswer={onAnswer}
      />,
    );
    stdin.write("\r");
    await until(() => onAnswer.mock.calls.length > 0);
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(answer).toEqual({ answer: "Postgres", wasFreeText: false });
  });

  it("arrow-down moves the selection to the next option", async () => {
    let answer: AskUserResponse | undefined;
    const onAnswer = vi.fn((a: AskUserResponse) => {
      answer = a;
    });
    const { stdin, lastFrame } = render(
      <SurveyPrompt
        question={QUESTION}
        options={OPTIONS}
        onAnswer={onAnswer}
      />,
    );
    stdin.write(ARROW_DOWN);
    // The pointer now sits on the SQLite row.
    await until(() =>
      (lastFrame() ?? "")
        .split("\n")
        .some((l) => l.includes("❯") && l.includes("SQLite")),
    );
    stdin.write("\r");
    await until(() => onAnswer.mock.calls.length > 0);
    expect(answer).toEqual({ answer: "SQLite", wasFreeText: false });
  });

  it("wraps from the top of the list to the free-text row on arrow-up", async () => {
    const { stdin, lastFrame } = render(
      <SurveyPrompt
        question={QUESTION}
        options={OPTIONS}
        onAnswer={() => {}}
      />,
    );
    stdin.write(ARROW_UP);
    await until(() =>
      (lastFrame() ?? "")
        .split("\n")
        .some((l) => l.includes("❯") && l.includes("Other (type your own)")),
    );
  });

  it("choosing the free-text row, typing, then Enter answers with free-text", async () => {
    let answer: AskUserResponse | undefined;
    const onAnswer = vi.fn((a: AskUserResponse) => {
      answer = a;
    });
    const { stdin, lastFrame } = render(
      <SurveyPrompt
        question={QUESTION}
        options={OPTIONS}
        onAnswer={onAnswer}
      />,
    );
    // Navigate down past both options onto the "Other" row and open the editor.
    stdin.write(ARROW_DOWN);
    stdin.write(ARROW_DOWN);
    await until(() =>
      (lastFrame() ?? "")
        .split("\n")
        .some((l) => l.includes("❯") && l.includes("Other (type your own)")),
    );
    stdin.write("\r");
    await until(() => (lastFrame() ?? "").includes("Type your answer"));
    stdin.write("MongoDB");
    await until(() => (lastFrame() ?? "").includes("MongoDB"));
    stdin.write("\r");
    await until(() => onAnswer.mock.calls.length > 0);
    expect(answer).toEqual({ answer: "MongoDB", wasFreeText: true });
  });

  it("an empty free-text submit is ignored until the user types something", async () => {
    const onAnswer = vi.fn();
    const { stdin, lastFrame } = render(
      <SurveyPrompt
        question={QUESTION}
        options={OPTIONS}
        onAnswer={onAnswer}
      />,
    );
    stdin.write(ARROW_UP); // wrap to the "Other" row (one above the first option)
    await until(() =>
      (lastFrame() ?? "")
        .split("\n")
        .some((l) => l.includes("❯") && l.includes("Other (type your own)")),
    );
    stdin.write("\r"); // open the input editor
    await until(() => (lastFrame() ?? "").includes("Type your answer"));
    stdin.write("\r"); // empty submit — must NOT answer
    // Give the handler a beat; onAnswer must remain uncalled.
    await new Promise((r) => setTimeout(r, 50));
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("Esc from the input editor returns to the option list without answering", async () => {
    const onAnswer = vi.fn();
    const { stdin, lastFrame } = render(
      <SurveyPrompt
        question={QUESTION}
        options={OPTIONS}
        onAnswer={onAnswer}
      />,
    );
    stdin.write(ARROW_UP); // onto the "Other" row
    await until(() =>
      (lastFrame() ?? "")
        .split("\n")
        .some((l) => l.includes("❯") && l.includes("Other (type your own)")),
    );
    stdin.write("\r");
    await until(() => (lastFrame() ?? "").includes("Type your answer"));
    stdin.write(ESC);
    await until(() => (lastFrame() ?? "").includes("↑↓ select"));
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("Esc from the list dismisses with the free-text sentinel", async () => {
    let answer: AskUserResponse | undefined;
    const onAnswer = vi.fn((a: AskUserResponse) => {
      answer = a;
    });
    const { stdin } = render(
      <SurveyPrompt
        question={QUESTION}
        options={OPTIONS}
        onAnswer={onAnswer}
      />,
    );
    stdin.write(ESC);
    await until(() => onAnswer.mock.calls.length > 0);
    expect(answer).toEqual({
      answer: SURVEY_DISMISS_ANSWER,
      wasFreeText: true,
    });
  });
});
