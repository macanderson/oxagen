/**
 * user_survey — pipeline step 1, ask-not-guess (Group 4).
 *
 * When a prompt is incomplete AND the gap is a real decision the developer owns
 * (scope, intent, a product/UX choice, a business tradeoff) that context cannot
 * recover and no best practice answers, the coordinator asks — briefly. This tool
 * presents a short set of focused questions, each with options AND a mandatory
 * free-text escape hatch, and returns the answers.
 *
 * Guardrails baked in here:
 *   - Every question offers free text (normalized on, per `alwaysAllowFreeText`).
 *   - The survey is capped at `config.survey.maxQuestions` (default 3); extra
 *     questions are dropped and the drop is logged (never silently truncated).
 *   - Questions are batched into one survey, not dripped one at a time.
 *
 * The *decision* of whether to ask at all lives in {@link decideClarification};
 * this tool assumes that decision was already made in favor of asking.
 *
 * The prompter is injected so this is testable and headless-safe: the default
 * reads from the terminal; a non-interactive session falls back to the
 * recommended option (or free text) without blocking. Every call is logged
 * (start/done, or skipped when the pipeline is off).
 */
import { createInterface } from "node:readline/promises";
import { readAssistConfig, type AssistPipelineConfig } from "./config.js";
import { logTool } from "./logging.js";
import type { SurveyAnswer, SurveyInput, SurveyOutput, SurveyQuestion } from "./types.js";

/** Presents one question to the developer and returns their answer. */
export interface SurveyPrompter {
  ask(question: SurveyQuestion): Promise<SurveyAnswer>;
}

export interface SurveyDeps {
  /** Injected prompter (defaults to a terminal readline prompter). */
  prompter?: SurveyPrompter;
  /** Injected config (defaults to {@link readAssistConfig}). */
  config?: AssistPipelineConfig;
}

/**
 * Normalize the caller's questions to satisfy the survey guardrails: guarantee a
 * free-text option on every question and cap the set at `maxQuestions`. Returns
 * the normalized questions and how many were dropped by the cap.
 */
export function normalizeQuestions(
  questions: SurveyQuestion[],
  config: AssistPipelineConfig["survey"],
): { questions: SurveyQuestion[]; dropped: number } {
  const capped = questions.slice(0, Math.max(0, config.maxQuestions));
  const normalized = capped.map((q) => ({
    ...q,
    // Every question MUST accept free text — coerce it on regardless of input.
    allowFreeText: config.alwaysAllowFreeText ? true : q.allowFreeText,
    options: q.options ?? [],
  }));
  return { questions: normalized, dropped: Math.max(0, questions.length - capped.length) };
}

/**
 * A terminal prompter over `readline`. Lists the numbered options, always offers
 * a free-text entry, and accepts either a number or typed text. In a
 * non-interactive session (no TTY) it resolves to the recommended option, else
 * the first option, else empty free text — never blocking a scripted run.
 */
export function terminalPrompter(): SurveyPrompter {
  return {
    async ask(question: SurveyQuestion): Promise<SurveyAnswer> {
      const recommended = question.options.find((o) => o.recommended);
      if (!process.stdin.isTTY) {
        if (recommended) {
          return { questionId: question.id, value: recommended.label, source: "option" };
        }
        if (question.options[0]) {
          return { questionId: question.id, value: question.options[0].label, source: "option" };
        }
        return { questionId: question.id, value: "", source: "free_text" };
      }

      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        process.stderr.write(`\n${question.prompt}\n`);
        question.options.forEach((o, i) => {
          process.stderr.write(`  ${i + 1}) ${o.label}${o.recommended ? "  (recommended)" : ""}\n`);
        });
        process.stderr.write(`  Or type your own answer (free text).\n`);
        const raw = (await rl.question("> ")).trim();
        const asIndex = Number.parseInt(raw, 10);
        if (
          raw !== "" &&
          Number.isInteger(asIndex) &&
          asIndex >= 1 &&
          asIndex <= question.options.length &&
          String(asIndex) === raw
        ) {
          const label = question.options[asIndex - 1]?.label ?? raw;
          return { questionId: question.id, value: label, source: "option" };
        }
        if (raw === "" && recommended) {
          return { questionId: question.id, value: recommended.label, source: "option" };
        }
        return { questionId: question.id, value: raw, source: "free_text" };
      } finally {
        rl.close();
      }
    },
  };
}

/**
 * Run the user_survey tool. Returns the developer's answers, or an empty answer
 * set when the pipeline is off (logged as a skip).
 */
export async function runSurvey(input: SurveyInput, deps: SurveyDeps = {}): Promise<SurveyOutput> {
  const config = deps.config ?? readAssistConfig();

  const surveyOff = !config.enabled || !config.survey.enabled;
  if (surveyOff) {
    await logTool({ tool: "survey", step: 1, status: "skipped" }, [
      ["reason", config.enabled ? "survey disabled" : "pipeline off"],
    ]);
    return { answers: [] };
  }

  const { questions, dropped } = normalizeQuestions(input.questions, config.survey);
  const prompter = deps.prompter ?? terminalPrompter();

  await logTool({ tool: "survey", step: 1, status: "start" }, [
    ["reason", input.reason],
    ["questions", questions.length],
    // Surface the cap so a dropped question is never silently truncated.
    ...(dropped > 0 ? ([["dropped", dropped]] as [string, number][]) : []),
  ]);

  const answers: SurveyAnswer[] = [];
  for (const question of questions) {
    answers.push(await prompter.ask(question));
  }

  const freeTextUsed = answers.filter((a) => a.source === "free_text").length;
  await logTool({ tool: "survey", step: 1, status: "done" }, [
    ["answered", answers.length],
    ["free_text_used", freeTextUsed],
  ]);

  return { answers };
}
