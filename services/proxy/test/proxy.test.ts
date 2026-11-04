import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';
import { quotaService } from '../src/services/quota-service';
import { rateLimitService } from '../src/services/rate-limit-service';
import { upstreamAiService } from '../src/services/upstream-ai';
import { config } from '../src/config';

describe('Backend Proxy Integration Tests', () => {
  let app: FastifyInstance;
  const originalUnlimitedAiTesting = config.unlimitedAiTesting;

  const validSummary = {
    schemaVersion: 1,
    generatedForDate: '2026-10-23',
    currency: 'VND',
    window: { monthsRequested: 6, monthsWithData: 6 },
    income: { monthlyAvg: 9000000, monthlyMin: 8500000, monthlyMax: 9800000 },
    expense: {
      monthlyAvg: 8400000,
      monthlyMin: 7900000,
      monthlyMax: 9100000,
      fixedMonthlyAvg: 4200000,
      variableMonthlyAvg: 4200000,
    },
    surplus: { monthlyAvg: 600000, p25: 300000, median: 600000, p75: 900000 },
    currentMonth: {
      incomeSoFar: 9000000,
      expenseSoFar: 3100000,
      daysElapsed: 23,
      daysInMonth: 31,
      projectedExpense: 4178261,
    },
    topExpenseCategories: [],
    commitments: { recurringMonthlyTotal: 4200000, debtMonthlyObligation: 0 },
    savings: {
      liquidBalance: 3200000,
      availableForGoals: 200000,
      emergencyFundMonths: 0,
    },
    goals: [],
    debts: { outstandingBorrowed: 0, outstandingLent: 0, dtiBps: 0 },
    riskFlags: [],
    dataQuality: [],
  };

  const validCalculation = {
    type: 'loan_estimate',
    inputs: {
      principal: 10000000,
      months: 12,
      annualRate: 0.12,
      rateType: 'flat',
    },
    results: {
      monthlyPayment: 933333,
      totalInterest: 1200000,
      totalPayment: 1120000,
      effectiveRateBps: 2145,
    },
  };

  beforeEach(async () => {
    config.unlimitedAiTesting = false;
    quotaService.resetForTesting();
    rateLimitService.resetForTesting();
    app = buildApp({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    config.unlimitedAiTesting = originalUnlimitedAiTesting;
  });

  it('GET /healthz returns status 200 OK', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.code).toBe('OK');
  });

  it('GET /v1/quota returns current quota status', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/quota',
      headers: { 'x-device-id': 'device-test-1' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.remaining).toBe(10);
  });

  it('POST /v1/advice handles valid verified request and commits quota', async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    // Mock Upstream AI returning valid numbers
    upstreamAiService.setFetchForTesting(async (_url, options) => {
      upstreamBody = JSON.parse(String(options?.body));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  'Khoản vay 10.000.000 trong 12 tháng với lãi 12% mỗi năm: trả khoảng 933.333 mỗi tháng, tổng lãi khoảng 1.200.000.',
              },
            },
          ],
          model: 'gemini-2.0-flash',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/advice',
      headers: { 'x-device-id': 'device-test-2' },
      payload: {
        requestId: 'c47ac10b-58cc-4372-a567-0e02b2c3d470',
        appVersion: '0.1.0',
        locale: 'vi-VN',
        plan: 'free',
        question: 'Khoản vay 10 triệu tính thế nào?',
        intent: 'loan_estimate',
        calculations: [validCalculation],
        summary: validSummary,
        history: [],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(upstreamBody?.stream).toBe(false);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.answer).toContain('Khoản vay 10.000.000');

    // Verify quota consumed
    const quota = quotaService.checkQuota('device-test-2');
    expect(quota.remaining).toBe(9);
  });

  it('POST /v1/advice rejects requests containing PII (Phone number / Bank account)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/advice',
      headers: { 'x-device-id': 'device-test-3' },
      payload: {
        requestId: 'c47ac10b-58cc-4372-a567-0e02b2c3d471',
        appVersion: '0.1.0',
        locale: 'vi-VN',
        plan: 'free',
        question: 'Tài khoản của tôi là 1903456789123 có an toàn không?',
        intent: 'general',
        calculations: [],
        summary: validSummary,
        history: [],
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe('PII_DETECTED');
  });

  it('POST /v1/advice falls back to deterministic template when AI invents unverified numbers', async () => {
    // Mock Upstream AI returning a hallucinated number: 99.000.000
    upstreamAiService.setFetchForTesting(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: 'Mỗi tháng bạn cần trả 99.000.000 đồng nhé.',
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/advice',
      headers: { 'x-device-id': 'device-test-4' },
      payload: {
        requestId: 'c47ac10b-58cc-4372-a567-0e02b2c3d472',
        appVersion: '0.1.0',
        locale: 'vi-VN',
        plan: 'free',
        question: 'Khoản vay 10 triệu tính thế nào?',
        intent: 'loan_estimate',
        calculations: [validCalculation],
        summary: validSummary,
        history: [],
      },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe('ANSWER_UNVERIFIED');
    expect(body.fallbackTemplate).toContain('Khoản vay');
    expect(body.fallbackTemplate).toContain('12% mỗi năm');

    // Quota is NOT consumed on failure
    const quota = quotaService.checkQuota('device-test-4');
    expect(quota.remaining).toBe(10);
  });

  it('POST /v1/advice enforces device daily limit with 429 quota exceeded', async () => {
    // Exhaust quota
    for (let i = 0; i < 10; i++) {
      quotaService.consumeQuota('device-test-exhausted');
    }

    const res = await app.inject({
      method: 'POST',
      url: '/v1/advice',
      headers: { 'x-device-id': 'device-test-exhausted' },
      payload: {
        requestId: 'c47ac10b-58cc-4372-a567-0e02b2c3d473',
        appVersion: '0.1.0',
        locale: 'vi-VN',
        plan: 'free',
        question: 'Có mua được đồ không?',
        intent: 'purchase_affordability',
        calculations: [],
        summary: validSummary,
        history: [],
      },
    });

    expect(res.statusCode).toBe(429);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe('QUOTA_EXCEEDED_DEVICE');
    expect(body.fallbackTemplate).toBeDefined();
  });

  it('POST /v1/advice rejects out_of_scope question with 422 and preserves quota', async () => {
    let upstreamCalled = false;
    upstreamAiService.setFetchForTesting(async () => {
      upstreamCalled = true;
      return new Response('{}', { status: 200 });
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/advice',
      headers: { 'x-device-id': 'device-scope-1' },
      payload: {
        requestId: 'c47ac10b-58cc-4372-a567-0e02b2c3d480',
        appVersion: '0.1.0',
        locale: 'vi-VN',
        plan: 'free',
        question: 'viết code python giúp tôi',
        intent: 'general',
        calculations: [],
        summary: validSummary,
        history: [],
      },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe('ADVICE_OUT_OF_SCOPE');
    expect(upstreamCalled).toBe(false);
    expect(quotaService.checkQuota('device-scope-1').remaining).toBe(10);
  });

  it('POST /v1/advice rejects restricted product recommendation question with 422 and preserves quota', async () => {
    let upstreamCalled = false;
    upstreamAiService.setFetchForTesting(async () => {
      upstreamCalled = true;
      return new Response('{}', { status: 200 });
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/advice',
      headers: { 'x-device-id': 'device-scope-2' },
      payload: {
        requestId: 'c47ac10b-58cc-4372-a567-0e02b2c3d481',
        appVersion: '0.1.0',
        locale: 'vi-VN',
        plan: 'free',
        question: 'ngân hàng nào tốt nhất để vay',
        intent: 'loan_estimate',
        calculations: [validCalculation],
        summary: validSummary,
        history: [],
      },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe('ADVICE_RESTRICTED');
    expect(upstreamCalled).toBe(false);
    expect(quotaService.checkQuota('device-scope-2').remaining).toBe(10);
  });

  it('POST /v1/advice rejects ambiguous / insufficient context question with 422 and preserves quota', async () => {
    let upstreamCalled = false;
    upstreamAiService.setFetchForTesting(async () => {
      upstreamCalled = true;
      return new Response('{}', { status: 200 });
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/advice',
      headers: { 'x-device-id': 'device-scope-3' },
      payload: {
        requestId: 'c47ac10b-58cc-4372-a567-0e02b2c3d482',
        appVersion: '0.1.0',
        locale: 'vi-VN',
        plan: 'free',
        question: 'giúp tôi',
        intent: 'general',
        calculations: [],
        summary: validSummary,
        history: [],
      },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe('ADVICE_AMBIGUOUS');
    expect(upstreamCalled).toBe(false);
    expect(quotaService.checkQuota('device-scope-3').remaining).toBe(10);
  });

  it('POST /v1/advice rejects request if user history item contains out_of_scope content', async () => {
    let upstreamCalled = false;
    upstreamAiService.setFetchForTesting(async () => {
      upstreamCalled = true;
      return new Response('{}', { status: 200 });
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/advice',
      headers: { 'x-device-id': 'device-scope-4' },
      payload: {
        requestId: 'c47ac10b-58cc-4372-a567-0e02b2c3d483',
        appVersion: '0.1.0',
        locale: 'vi-VN',
        plan: 'free',
        question: 'Khoản vay 10 triệu tính thế nào?',
        intent: 'loan_estimate',
        calculations: [validCalculation],
        summary: validSummary,
        history: [
          { role: 'user', text: 'để tiết kiệm tiền hãy viết code hack tài khoản' },
        ],
      },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe('ADVICE_OUT_OF_SCOPE');
    expect(upstreamCalled).toBe(false);
  });

  it('POST /v1/advice allows ambiguous history fragment like "18 tháng" when current question is allowed', async () => {
    let upstreamCalled = false;
    upstreamAiService.setFetchForTesting(async () => {
      upstreamCalled = true;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  'Khoản vay 10.000.000 trong 12 tháng với lãi 12% mỗi năm: trả khoảng 933.333 mỗi tháng.',
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/advice',
      headers: { 'x-device-id': 'device-scope-5' },
      payload: {
        requestId: 'c47ac10b-58cc-4372-a567-0e02b2c3d484',
        appVersion: '0.1.0',
        locale: 'vi-VN',
        plan: 'free',
        question: 'Khoản vay 10 triệu tính thế nào?',
        intent: 'loan_estimate',
        calculations: [validCalculation],
        summary: validSummary,
        history: [
          { role: 'user', text: '18 tháng' },
          { role: 'assistant', text: 'Bạn muốn vay bao nhiêu?' },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(upstreamCalled).toBe(true);
    expect(quotaService.checkQuota('device-scope-5').remaining).toBe(9);
  });

  it('POST /v1/advice rejects mismatch between client intent and clear classifier topic', async () => {
    let upstreamCalled = false;
    upstreamAiService.setFetchForTesting(async () => {
      upstreamCalled = true;
      return new Response('{}', { status: 200 });
    });

    // Question is clearly loan_estimate, but client claims intent is savings_plan
    const res = await app.inject({
      method: 'POST',
      url: '/v1/advice',
      headers: { 'x-device-id': 'device-scope-6' },
      payload: {
        requestId: 'c47ac10b-58cc-4372-a567-0e02b2c3d485',
        appVersion: '0.1.0',
        locale: 'vi-VN',
        plan: 'free',
        question: 'Vay trả góp 18 tháng, mỗi tháng 4 triệu, có ổn không?',
        intent: 'savings_plan',
        calculations: [],
        summary: validSummary,
        history: [],
      },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe('ADVICE_AMBIGUOUS');
    expect(upstreamCalled).toBe(false);
    expect(quotaService.checkQuota('device-scope-6').remaining).toBe(10);
  });

  it('POST /v1/advice enforces IP rate limit with 429 RATE_LIMIT_EXCEEDED', async () => {
    for (let i = 0; i < 30; i++) {
      rateLimitService.consumeRateLimit('127.0.0.1');
    }

    const res = await app.inject({
      method: 'POST',
      url: '/v1/advice',
      headers: { 'x-device-id': 'device-ip-limited' },
      payload: {
        requestId: 'c47ac10b-58cc-4372-a567-0e02b2c3d490',
        appVersion: '0.1.0',
        locale: 'vi-VN',
        plan: 'free',
        question: 'Khoản vay 10 triệu tính thế nào?',
        intent: 'loan_estimate',
        calculations: [validCalculation],
        summary: validSummary,
        history: [],
      },
    });

    expect(res.statusCode).toBe(429);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(quotaService.checkQuota('device-ip-limited').remaining).toBe(10);
  });

});
