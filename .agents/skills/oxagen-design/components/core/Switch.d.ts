import * as React from "react";

/** Toggle switch. Controlled via `checked` or uncontrolled via `defaultChecked`. */
export interface SwitchProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  style?: React.CSSProperties;
}

export function Switch(props: SwitchProps): React.ReactElement;
