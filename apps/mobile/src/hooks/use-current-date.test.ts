import { afterEach, expect, it, vi } from 'vitest';
import { watchVietnamDate } from './use-current-date';

vi.mock('react-native', () => ({ AppState: {} }));
afterEach(() => vi.useRealTimers());

it('refreshes at Vietnamese midnight and stops after disposal', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-30T16:59:59Z'));
  const update = vi.fn();
  const dispose = watchVietnamDate(update);
  vi.advanceTimersByTime(999);
  expect(update).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(update).toHaveBeenLastCalledWith('2026-12-01');
  vi.advanceTimersByTime(86400000);
  expect(update).toHaveBeenLastCalledWith('2026-12-02');
  dispose();
  vi.advanceTimersByTime(86400000);
  expect(update).toHaveBeenCalledTimes(2);
});
