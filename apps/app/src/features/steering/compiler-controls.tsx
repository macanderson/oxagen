"use client";
// The Compiler's controls (roadmap pages/steering-compiler.md, Controls): the
// Agent select, whose choice is the URL's agent segment, and the Prompt
// textarea. Changing the agent navigates, so the pick is a link somebody can
// send and a reload lands on it. The prompt is the viewer's own text and
// stays in the textarea; nothing assembles it yet (#3879), and the panel
// under the controls says so rather than repainting a result nobody computed.
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import type { SafePath } from "@/shared/safe-path";
import { inputBase } from "@/ui/control-styles";
import { useNavigate } from "@/ui/navigation";

export type CompilerAgentOption = {
  slug: string;
  /** "name · harness", as the select prints it. */
  label: string;
  /** Where picking it goes: `/steering/compiler/<slug>`. */
  to: SafePath;
};

const field = `${inputBase} max-md:text-base`;

export function CompilerControls({
  agents,
  selected,
  hint,
}: {
  agents: readonly CompilerAgentOption[];
  selected: string;
  /** The line under the select: the tier and the repository, as far as they are recorded. */
  hint: string;
}) {
  const t = useTranslations("steering.bodies.compiler");
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState("");
  const agentId = useId();
  const promptId = useId();
  return (
    <div
      className="grid gap-3.5 md:grid-cols-2"
      data-testid="compiler-controls"
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        <label
          htmlFor={agentId}
          className="text-[12.5px] font-semibold text-foreground"
        >
          {t("agent")}
        </label>
        <select
          id={agentId}
          className={field}
          value={selected}
          onChange={(event) => {
            const next = agents.find((a) => a.slug === event.target.value);
            if (next !== undefined) navigate.push(next.to);
          }}
        >
          {agents.map((agent) => (
            <option key={agent.slug} value={agent.slug}>
              {agent.label}
            </option>
          ))}
        </select>
        <p
          className="text-[12px] text-muted-foreground"
          data-testid="compiler-agent-hint"
        >
          {hint}
        </p>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <label
          htmlFor={promptId}
          className="text-[12.5px] font-semibold text-foreground"
        >
          {t("prompt")}
        </label>
        <textarea
          id={promptId}
          rows={2}
          className={field}
          placeholder={t("placeholder")}
          value={prompt}
          onChange={(event) => {
            setPrompt(event.target.value);
          }}
        />
      </div>
    </div>
  );
}
