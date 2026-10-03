"use client";
// The four-segment meter and the requirement list under a new password
// (mockups `obPwField`, `obPwBits`). The meter is decoration and hidden from
// assistive technology; the list carries the meaning in words, each line saying
// whether the value meets it.
import { useTranslations } from "next-intl";
import { passwordMeterScore, passwordRequirements } from "../schemas";

const SEGMENTS = [1, 2, 3, 4] as const;
const REQUIREMENTS = ["length", "symbol", "digit"] as const;

export function PasswordStrength({ id, value }: { id: string; value: string }) {
  const t = useTranslations("auth.fields.requirements");
  const score = passwordMeterScore(value);
  const met = passwordRequirements(value);
  return (
    <div className="flex flex-col gap-1.5">
      <div aria-hidden data-testid="password-meter" className="flex gap-1">
        {SEGMENTS.map((segment) => (
          <i
            key={segment}
            data-on={segment <= score || undefined}
            className={`h-[3px] flex-1 rounded-sm ${segment <= score ? "bg-success" : "bg-hl"}`}
          />
        ))}
      </div>
      <ul id={id} aria-label={t("label")} className="grid gap-[3px]">
        {REQUIREMENTS.map((requirement) => (
          <li
            key={requirement}
            data-met={met[requirement] || undefined}
            className={`flex items-center gap-1.5 text-[11.5px] ${met[requirement] ? "text-success" : "text-dim"}`}
          >
            <span aria-hidden>{met[requirement] ? "✓" : "·"}</span>
            <span>{t(requirement)}</span>
            <span className="sr-only">
              {met[requirement] ? t("met") : t("unmet")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
