import { afterEach, beforeEach, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { config } from '../src/config';
import { quotaService } from '../src/services/quota-service';
import { rateLimitService } from '../src/services/rate-limit-service';
import { upstreamAiService } from '../src/services/upstream-ai';

const imageBase64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
const payload = { mimeType: 'image/jpeg', imageBase64 };
const originalModel = config.receiptVisionModel;
const originalTimeout = config.upstreamTimeoutMs;
const originalUnlimitedAiTesting = config.unlimitedAiTesting;

beforeEach(() => {
  config.unlimitedAiTesting = false;
  quotaService.resetForTesting();
  rateLimitService.resetForTesting();
  config.receiptVisionModel = 'vision-test';
});

afterEach(() => {
  config.unlimitedAiTesting = originalUnlimitedAiTesting;
  config.receiptVisionModel = originalModel;
  config.upstreamTimeoutMs = originalTimeout;
  upstreamAiService.setFetchForTesting(fetch);
});

it('returns one reviewable payable total without saving a transaction', async () => {
  let upstreamBody = '';
  upstreamAiService.setFetchForTesting(async (_url, options) => {
    upstreamBody = String(options?.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ merchant: 'Quán A', totalVnd: 87000, occurredOn: '2026-11-02' }) } }] }), { status: 200 });
  });
  const app = buildApp({ logger: false });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/receipts/scan', headers: { 'x-device-id': 'receipt-test' }, payload });
    expect(response.statusCode).toBe(200);
    expect(response.json().receipt).toEqual({ merchant: 'Quán A', totalVnd: 87000, occurredOn: '2026-11-02', categoryKey: null });
    expect(upstreamBody).toContain('image_url');
    expect(upstreamBody).toContain('vision-test');
    expect(upstreamBody).toContain('expense.housing.rent');
    expect(quotaService.checkQuota('receipt-test').remaining).toBe(9);
  } finally { await app.close(); }
});

it('returns a validated rent category suggestion for a housing bill', async () => {
  upstreamAiService.setFetchForTesting(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ merchant: 'Ban quan ly ABC', totalVnd: 3000000, occurredOn: '2026-11-02', categoryKey: 'expense.housing.rent' }) } }] }), { status: 200 }));
  const app = buildApp({ logger: false });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/receipts/scan', headers: { 'x-device-id': 'rent-receipt' }, payload });
    expect(response.statusCode).toBe(200);
    expect(response.json().receipt.categoryKey).toBe('expense.housing.rent');
  } finally { await app.close(); }
});

it('keeps the payable amount but clears a category outside the allowed list', async () => {
  upstreamAiService.setFetchForTesting(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ merchant: 'Ban quan ly ABC', totalVnd: 3000000, occurredOn: '2026-11-02', categoryKey: 'expense.fake' }) } }] }), { status: 200 }));
  const app = buildApp({ logger: false });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/receipts/scan', headers: { 'x-device-id': 'invalid-category' }, payload });
    expect(response.statusCode).toBe(200);
    expect(response.json().receipt).toMatchObject({ totalVnd: 3000000, categoryKey: null });
  } finally { await app.close(); }
});

it('rejects a non-JPEG image before calling the model', async () => {
  let called = false;
  upstreamAiService.setFetchForTesting(async () => { called = true; throw new Error('unexpected upstream'); });
  const app = buildApp({ logger: false });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/receipts/scan', payload: { mimeType: 'image/png', imageBase64 } });
    expect(response.statusCode).toBe(400);
    expect(called).toBe(false);
  } finally { await app.close(); }
});

it('does not return a phone number copied from the image as the merchant', async () => {
  upstreamAiService.setFetchForTesting(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ merchant: 'Quán A 0912345678', totalVnd: 87000, occurredOn: '2026-11-02' }) } }] }), { status: 200 }));
  const app = buildApp({ logger: false });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/receipts/scan', payload });
    expect(response.statusCode).toBe(200);
    expect(response.json().receipt.merchant).toBeNull();
  } finally { await app.close(); }
});

it('keeps an uncertain final total empty for manual review', async () => {
  upstreamAiService.setFetchForTesting(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ merchant: 'Cua hang B', totalVnd: null, occurredOn: null }) } }] }), { status: 200 }));
  const app = buildApp({ logger: false });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/receipts/scan', payload });
    expect(response.statusCode).toBe(200);
    expect(response.json().receipt.totalVnd).toBeNull();
    expect(response.json().warnings).toContain('TOTAL_UNCERTAIN');
  } finally { await app.close(); }
});

it('rejects an invalid model date and does not charge quota', async () => {
  upstreamAiService.setFetchForTesting(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ merchant: 'Cua hang B', totalVnd: 120000, occurredOn: '2026-02-30' }) } }] }), { status: 200 }));
  const app = buildApp({ logger: false });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/receipts/scan', headers: { 'x-device-id': 'invalid-date' }, payload });
    expect(response.statusCode).toBe(502);
    expect(response.json().code).toBe('RECEIPT_UNVERIFIED');
    expect(quotaService.checkQuota('invalid-date').remaining).toBe(10);
  } finally { await app.close(); }
});

it('does not fall back to a text model when the vision model is unset', async () => {
  config.receiptVisionModel = '';
  let called = false;
  upstreamAiService.setFetchForTesting(async () => { called = true; throw new Error('unexpected upstream'); });
  const app = buildApp({ logger: false });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/receipts/scan', payload });
    expect(response.statusCode).toBe(503);
    expect(called).toBe(false);
  } finally { await app.close(); }
});

it('rejects an oversized image before contacting the model', async () => {
  let called = false;
  upstreamAiService.setFetchForTesting(async () => { called = true; throw new Error('unexpected upstream'); });
  const oversized = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(2 * 1024 * 1024), Buffer.from([0xff, 0xd9])]);
  const app = buildApp({ logger: false });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/receipts/scan', payload: { mimeType: 'image/jpeg', imageBase64: oversized.toString('base64') } });
    expect(response.statusCode).toBe(400);
    expect(called).toBe(false);
  } finally { await app.close(); }
});

it('rejects malformed model JSON without exposing its content', async () => {
  const sentinel = 'PRIVATE_RECEIPT_SENTINEL';
  upstreamAiService.setFetchForTesting(async () => new Response(JSON.stringify({ choices: [{ message: { content: sentinel } }] }), { status: 200 }));
  const app = buildApp({ logger: false });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/receipts/scan', payload });
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain(sentinel);
  } finally { await app.close(); }
});

it('returns a clear error when the vision model times out', async () => {
  config.upstreamTimeoutMs = 5;
  upstreamAiService.setFetchForTesting(async (_url, options) => new Promise<Response>((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  const app = buildApp({ logger: false });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/receipts/scan', payload });
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('UPSTREAM_UNAVAILABLE');
  } finally { await app.close(); }
});
