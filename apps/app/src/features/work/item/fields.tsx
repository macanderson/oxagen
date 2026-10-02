// The fields the Work item dialogs share. A reason is required on every
// decision that changes the item (workReasonSchema: 1 to 2000 characters),
// so the browser refuses an empty one before the write is sent.
import { fieldHint, fieldLabel, textareaBase } from "@/ui/control-styles";

export function ReasonField({
  id,
  label,
  hint,
  defaultValue,
}: {
  id: string;
  label: string;
  hint?: string;
  defaultValue?: string;
}) {
  const hintId = `${id}-hint`;
  return (
    <div className="flex flex-col">
      <label htmlFor={id} className={fieldLabel}>
        {label}
      </label>
      <textarea
        id={id}
        name="reason"
        required
        rows={3}
        maxLength={2000}
        defaultValue={defaultValue}
        aria-describedby={hint === undefined ? undefined : hintId}
        className={textareaBase}
      />
      {hint === undefined ? null : (
        <p id={hintId} className={fieldHint}>
          {hint}
        </p>
      )}
    </div>
  );
}
