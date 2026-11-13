import { useEffect, useMemo, useState } from 'react';

/** Restarts the three-second dismissal timer for every new feedback event. */
export function createTransientState<T>(publish: (value: T) => void, empty: T) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => clearTimeout(timer);
  return {
    dispose,
    set(value: T) {
      dispose();
      publish(value);
      if (!Object.is(value, empty)) {
        timer = setTimeout(() => publish(empty), 3000);
      }
    },
  };
}

/** Keeps action feedback visible for three seconds and cleans up on unmount. */
export function useTransientState<T>(empty: T) {
  const [value, publish] = useState(empty);
  const state = useMemo(() => createTransientState(publish, empty), [empty]);
  useEffect(() => state.dispose, [state]);
  return [value, state.set] as const;
}
