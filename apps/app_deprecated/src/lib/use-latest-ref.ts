import * as React from "react";

/**
 * useLatestRef — returns a ref whose `.current` always holds the latest value.
 *
 * Standard pattern for avoiding stale closures in callbacks without adding
 * the value to the callback's dependency array.
 *
 * @example
 *   const onChangeRef = useLatestRef(onChange);
 *   const handler = useCallback(() => onChangeRef.current?.(), []);
 */
export function useLatestRef<T>(value: T): React.RefObject<T> {
  const ref = React.useRef(value);
  React.useLayoutEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
