"use client";
// The heading of a result that replaced the form a person just submitted. The
// submit button unmounts with the form, so focus would fall to the body and a
// screen reader would say nothing. The heading takes focus once, on mount, so
// the result is read out and the keyboard continues from it.
import { type ReactNode, useEffect, useRef } from "react";

export function FocusedHeading({
  id,
  className,
  children,
}: {
  id?: string;
  className: string;
  children: ReactNode;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  return (
    <h2
      ref={headingRef}
      id={id}
      tabIndex={-1}
      className={`${className} focus:outline-none`}
    >
      {children}
    </h2>
  );
}
