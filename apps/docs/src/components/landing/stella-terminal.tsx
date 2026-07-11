"use client";

import { TypewriterTerminal, type TerminalStep } from "@/components/landing/typewriter-terminal";

/**
 * StellaTerminal — the /stella landing-page animated terminal: sets a provider
 * key, runs goal mode, and ends on the witness gate confirming the work —
 * the sequence that shows Stella's judged, evidence-verified loop.
 * Rendering + typing animation live in TypewriterTerminal.
 */

const STEPS: TerminalStep[] = [
  {
    cmd: "export ANTHROPIC_API_KEY=sk-ant-…",
    out: [{ kind: "dim", text: "BYOK: any provider key works. No account, no sign-up." }],
  },
  {
    cmd: 'stella goal "the parser handles CRLF files and tests pass" --budget 5',
    out: [
      { kind: "dim", text: "◇ round 1 · worker anthropic/claude-fable-5 · budget $5.00" },
      { kind: "out", text: "→ read_file src/parser.rs · grep \"\\r\\n\" · run_tests kind=unit" },
      { kind: "out", text: "→ edit_file src/parser.rs · write_file tests/crlf_test.rs" },
      { kind: "out", text: "→ verify_done · witness fails on HEAD, passes on new code" },
      { kind: "ok", text: "✓ WITNESS CONFIRMED · judge: goal met · spent $0.14 of $5.00" },
    ],
  },
  {
    cmd: "stella models",
    out: [
      { kind: "out", text: "anthropic  ✓ key set    claude-fable-5" },
      { kind: "out", text: "openai     · no key     gpt-5.5" },
      { kind: "out", text: "local      ✓ --base-url llama3.3 via Ollama" },
      { kind: "dim", text: "…7 more providers · pin one with --model provider/model" },
    ],
  },
];

export function StellaTerminal() {
  return <TypewriterTerminal steps={STEPS} title="stella — goal mode" minHeightClass="min-h-[300px]" />;
}
