import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { addDays } from '@pfm/domain';
import { vietnamToday } from '@/utils/calendar';

/** Refreshes the date at midnight in the application's Vietnamese time zone. */
export function watchVietnamDate(update: (date: string) => void) {
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    const date = vietnamToday();
    const next = Date.parse(`${addDays(date, 1)}T00:00:00+07:00`);
    timer = setTimeout(
      () => {
        update(vietnamToday());
        schedule();
      },
      Math.max(1, next - Date.now()),
    );
  };
  schedule();
  return () => clearTimeout(timer);
}

/** Keeps open screens current across midnight and application resume. */
export function useCurrentDate() {
  const [date, setDate] = useState(() => vietnamToday());
  useEffect(() => {
    const stop = watchVietnamDate(setDate);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') setDate(vietnamToday());
    });
    return () => {
      stop();
      subscription.remove();
    };
  }, []);
  return date;
}
