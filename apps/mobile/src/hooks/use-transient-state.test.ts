import { afterEach, expect, it, vi } from 'vitest';
import { createTransientState } from './use-transient-state';

afterEach(() => vi.useRealTimers());

it('clears feedback only after three seconds and restarts for an identical message', () => {
  vi.useFakeTimers();
  let value = '';
  const state = createTransientState<string>((next: string) => {
    value = next;
  }, '');
  state.set('Saved');
  vi.advanceTimersByTime(2999);
  expect(value).toBe('Saved');
  state.set('Saved');
  vi.advanceTimersByTime(2999);
  expect(value).toBe('Saved');
  vi.advanceTimersByTime(1);
  expect(value).toBe('');
});

it('cancels old feedback and disposes timers when the screen closes', () => {
  vi.useFakeTimers();
  const set = vi.fn();
  const state = createTransientState<boolean>(set, false);
  state.set(true);
  state.set(false);
  vi.advanceTimersByTime(5000);
  expect(set.mock.calls).toEqual([[true], [false]]);
  state.set(true);
  state.dispose();
  vi.advanceTimersByTime(5000);
  expect(set).toHaveBeenCalledTimes(3);
});
