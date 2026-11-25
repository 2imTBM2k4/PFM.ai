import { expect, it, vi } from 'vitest';
import { createLogger, logLocalAIEntry } from './logger';

it('writes local draft metadata with nine fields and rejects payloads disguised as an identifier', () => {
  vi.stubGlobal('__DEV__', true);
  const write = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    logLocalAIEntry('11111111-2222-4333-8444-555555555555', 'guest');
    const record = JSON.parse(write.mock.calls[0][0]);
    expect(Object.keys(record).sort()).toEqual(
      [
        'request_id',
        'model',
        'latency_ms',
        'intent',
        'tool_calls',
        'fallback_used',
        'bypass_used',
        'auth_mode',
        'error_code',
      ].sort(),
    );
    expect(record).toMatchObject({
      intent: 'entry',
      model: null,
      auth_mode: 'guest',
      tool_calls: [],
    });
    expect(() => logLocalAIEntry('PRIVATE amount 123', 'guest')).toThrow(
      'LOG_FIELD_REJECTED',
    );
    expect(write).toHaveBeenCalledTimes(1);
  } finally {
    write.mockRestore();
    vi.unstubAllGlobals();
  }
});

it('permits bounded entry lifecycle diagnostics without accepting private text', () => {
  const output: unknown[] = [];
  const log = createLogger((entry) => output.push(entry));
  for (const action of [
    'confirm_open',
    'save_started',
    'save_committed',
    'save_failed',
    'confirm_cancelled',
    'screen_blurred',
    'screen_unmounted',
    'save_in_history_page',
    'save_outside_history_page',
    'history_with_parsed',
    'history_without_parsed',
  ]) {
    log('debug', { route: 'entry', status: 'ready', action });
  }
  expect(output).toHaveLength(11);
  expect(() => log('error', { action: 'SECRET_SENTINEL' })).toThrow(
    'LOG_FIELD_REJECTED',
  );
  expect(output).toHaveLength(11);
});

it('permits fixed lock diagnostic categories but rejects arbitrary native error text', () => {
  const output: unknown[] = [];
  const log = createLogger((entry) => output.push(entry));
  log('error', {
    route: 'lock',
    status: 'failed',
    errorCode: 'LOCK_STORAGE_WRITE_FAILED',
    nativeReason: 'INTERACTION_NOT_ALLOWED',
  });
  expect(output).toHaveLength(1);
  expect(() => log('error', { nativeReason: 'SECRET_SENTINEL' })).toThrow(
    'LOG_FIELD_REJECTED',
  );
  expect(output).toHaveLength(1);
});

it('writes operational fields and rejects sensitive or nested content', () => {
  const output: unknown[] = [];
  const log = createLogger((entry) => output.push(entry));
  log('info', { route: 'startup', status: 'ready', latency: 12 });
  expect(output).toEqual([
    { level: 'info', route: 'startup', status: 'ready', latency: 12 },
  ]);
  for (const field of [
    'note',
    'amount',
    'question',
    'pin',
    'text',
    'walletName',
    'error',
    'accessToken',
    'token',
    'accountEmail',
    'email',
    'snapshot',
    'counterparty_label',
  ]) {
    expect(() => log('error', { [field]: 'SENTINEL_PRIVATE_TEXT' })).toThrow(
      'LOG_FIELD_REJECTED',
    );
  }
  expect(() =>
    log('error', { errorCode: { question: 'SENTINEL_PRIVATE_TEXT' } }),
  ).toThrow();
  expect(() => log('info', { status: 'SENTINEL_PRIVATE_TEXT' })).toThrow();
  expect(() =>
    log('info', { route: 'backup', action: 'ya29.a0AfH6SM_SECRET_TOKEN' }),
  ).toThrow('LOG_FIELD_REJECTED');
  expect(() =>
    log('info', { route: 'backup', action: 'minh@example.com' }),
  ).toThrow('LOG_FIELD_REJECTED');
  expect(output).toHaveLength(1);
});
