import * as React from "react";
import { m, AnimatePresence } from "../lib/motion.js";
import { Stepper } from "./Stepper.jsx";

/**
 * Oxagen OnboardingWizard — a multi-step flow shell wrapping the Stepper with
 * animated step transitions (slide+fade) and Back/Next controls. Provide
 * `steps: { label, description?, render: (ctx) => node }[]`. The wizard tracks
 * the current index, calls `onComplete()` on the final Next, and exposes
 * `{ index, goNext, goBack, setData, data }` to each step's render.
 */
export function OnboardingWizard({ steps = [], onComplete = () => {}, initialData = {}, style }) {
  const [index, setIndex] = React.useState(0);
  const [dir, setDir] = React.useState(1);
  const [data, setData] = React.useState(initialData);
  const last = index === steps.length - 1;

  function goNext() {
    if (last) return onComplete(data);
    setDir(1); setIndex((i) => Math.min(i + 1, steps.length - 1));
  }
  function goBack() {
    if (index === 0) return;
    setDir(-1); setIndex((i) => Math.max(i - 1, 0));
  }
  const update = (patch) => setData((d) => ({ ...d, ...patch }));
  const ctx = { index, goNext, goBack, data, setData: update };

  const Slide = m("div");
  const step = steps[index] || {};

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22, ...style }}>
      <Stepper steps={steps.map((s) => ({ label: s.label, description: s.description }))} current={index} />
      <div style={{ position: "relative", minHeight: 220 }}>
        <AnimatePresence mode="wait" initial={false}>
          <Slide
            key={index}
            initial={{ opacity: 0, x: dir * 28 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: dir * -28 }}
            transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
          >
            {typeof step.render === "function" ? step.render(ctx) : step.render}
          </Slide>
        </AnimatePresence>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button
          onClick={goBack}
          disabled={index === 0}
          style={{
            height: 38, padding: "0 16px", borderRadius: "var(--radius-md)",
            border: "1px solid var(--border)", background: "transparent",
            color: "var(--foreground)", fontSize: 13, fontWeight: 500,
            cursor: index === 0 ? "not-allowed" : "pointer", opacity: index === 0 ? 0.45 : 1,
            fontFamily: "var(--font-sans)",
          }}
        >
          Back
        </button>
        <span style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--muted-foreground)" }}>
          Step {index + 1} of {steps.length}
        </span>
        <button
          onClick={goNext}
          style={{
            height: 38, padding: "0 20px", borderRadius: "var(--radius-md)",
            border: "1px solid transparent", background: "var(--grad-sunset)",
            color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer",
            boxShadow: "var(--glow-violet)", fontFamily: "var(--font-sans)",
          }}
        >
          {last ? "Finish setup" : "Continue"}
        </button>
      </div>
    </div>
  );
}
