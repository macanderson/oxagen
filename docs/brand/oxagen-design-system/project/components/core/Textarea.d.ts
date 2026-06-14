import * as React from "react";

/** Multi-line text input. Set `invalid` for the error ring. */
export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export function Textarea(props: TextareaProps): React.ReactElement;
