"use client";
// The API keys roster's Rows select (the design's list control: 5, 10, 25, 50,
// All). The roster is paged on the server by query values, so a choice is a
// navigation to the link the server built for it, which keeps the page size
// in the URL beside the filter and the workspace.
import { useTranslations } from "next-intl";
import { useId } from "react";
import type { SafePath } from "@/shared/safe-path";
import { listSelect } from "@/ui/list-table";
import { useNavigate } from "@/ui/navigation";

export function ApiKeysRows({
  current,
  options,
}: {
  /** The rows per page in force; 0 is All. */
  current: number;
  options: readonly { rows: number; to: SafePath }[];
}) {
  const t = useTranslations("ui.listTable");
  const id = useId();
  const navigate = useNavigate();
  return (
    <span className="ml-auto inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-muted-foreground max-md:ml-0">
      <label htmlFor={id}>{t("rows")}</label>
      <select
        id={id}
        value={current}
        data-touch-target=""
        className={listSelect}
        onChange={(event) => {
          const wanted = Number(event.currentTarget.value);
          const option = options.find((o) => o.rows === wanted);
          if (option !== undefined) navigate.push(option.to);
        }}
      >
        {options.map((option) => (
          <option key={option.rows} value={option.rows}>
            {option.rows === 0 ? t("all") : String(option.rows)}
          </option>
        ))}
      </select>
    </span>
  );
}
