import { expect, it } from 'vitest';
import { scanReceipt } from './receipt-service';

it('sends one JPEG through the proxy and validates the returned receipt', async () => {
  const calls: { url: string; options?: RequestInit }[] = [];
  const fakeFetch: typeof fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ success: true, message: 'OK', code: 'OK', receipt: { merchant: 'Quán A', totalVnd: 87000, occurredOn: '2026-11-02' }, warnings: [] }), { status: 200 });
  };
  const result = await scanReceipt('jpeg-base64', 'https://proxy.example', 'device-1', fakeFetch);
  expect(result.receipt.totalVnd).toBe(87000);
  expect(calls[0].url).toBe('https://proxy.example/v1/receipts/scan');
  expect(calls[0].options?.headers).toMatchObject({ 'x-device-id': 'device-1' });
});

it('does not accept an unvalidated amount from a malformed proxy reply', async () => {
  const fakeFetch: typeof fetch = async () => new Response(JSON.stringify({ success: true, message: 'OK', code: 'OK', receipt: { merchant: 'Quán A', totalVnd: -1, occurredOn: null }, warnings: [] }), { status: 200 });
  await expect(scanReceipt('jpeg-base64', 'https://proxy.example', 'device-1', fakeFetch)).rejects.toThrow();
});

it('does not send a receipt photo over HTTP outside development', async () => {
  let called = false;
  const fakeFetch: typeof fetch = async () => { called = true; throw new Error('unexpected request'); };
  await expect(scanReceipt('jpeg-base64', 'http://proxy.example', 'device-1', fakeFetch)).rejects.toThrow();
  expect(called).toBe(false);
});
