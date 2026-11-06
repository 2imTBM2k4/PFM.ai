import {
  type AdviceRequest,
  AdviceRequestSchema,
  type Calculation,
} from '@pfm/contracts';
import {
  classifyAdviceScope,
  renderFallbackTemplate,
  verifyNumbers,
} from '@pfm/domain';
import type { FastifyPluginAsync } from 'fastify';

import { config } from '../config';
import { AppError } from '../errors/app-error';
import { scanPii } from '../services/pii-scanner';
import { quotaService } from '../services/quota-service';
import { rateLimitService } from '../services/rate-limit-service';
import { upstreamAiService } from '../services/upstream-ai';

// Extract all valid numbers from summary and calculations that the AI is permitted to mention.
function extractAllowedNumbers(
  summary: AdviceRequest['summary'],
  calculations: Calculation[],
): number[] {
  const allowed = new Set<number>();

  function addVal(val: number | null | undefined): void {
    if (typeof val === 'number' && Number.isFinite(val)) {
      allowed.add(val);
    }
  }

  // Summary numbers
  addVal(summary.income.monthlyAvg);
  addVal(summary.income.monthlyMin);
  addVal(summary.income.monthlyMax);

  addVal(summary.expense.monthlyAvg);
  addVal(summary.expense.monthlyMin);
  addVal(summary.expense.monthlyMax);
  addVal(summary.expense.fixedMonthlyAvg);
  addVal(summary.expense.variableMonthlyAvg);

  addVal(summary.surplus.monthlyAvg);
  addVal(summary.surplus.p25);
  addVal(summary.surplus.median);
  addVal(summary.surplus.p75);

  addVal(summary.currentMonth.incomeSoFar);
  addVal(summary.currentMonth.expenseSoFar);
  addVal(summary.currentMonth.projectedExpense);

  addVal(summary.commitments.recurringMonthlyTotal);
  addVal(summary.commitments.debtMonthlyObligation);

  addVal(summary.savings.liquidBalance);
  addVal(summary.savings.availableForGoals);
  addVal(summary.savings.emergencyFundMonths);

  addVal(summary.debts.outstandingBorrowed);
  addVal(summary.debts.outstandingLent);
  if (summary.debts.dtiBps !== null) {
    addVal(summary.debts.dtiBps / 100); // e.g. 2000 bps -> 20%
    addVal(summary.debts.dtiBps);
  }

  for (const cat of summary.topExpenseCategories) {
    addVal(cat.monthlyAvg);
    addVal(cat.shareBps / 100);
    if (cat.changeVsPrevPctBps !== null) {
      addVal(cat.changeVsPrevPctBps / 100);
    }
  }

  for (const goal of summary.goals) {
    addVal(goal.progressBps / 100);
    addVal(goal.monthsLeft);
    addVal(goal.requiredPerMonth);
  }

  // Calculations numbers
  for (const calc of calculations) {
    for (const val of [
      ...Object.values(calc.inputs),
      ...Object.values(calc.results),
    ]) {
      if (typeof val === 'number' && Number.isFinite(val)) {
        addVal(val);
        if (val > 0 && val <= 1) {
          addVal(Math.round(val * 100)); // Percentage representation e.g. 0.12 -> 12
        }
      }
    }
  }

  return Array.from(allowed);
}

export const adviceRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/v1/advice', async (request) => {
    // 0. IP-level rate limiting to protect against spam / DoS
    const clientIp = request.ip || '127.0.0.1';
    const rateLimit = rateLimitService.checkRateLimit(clientIp);
    if (!rateLimit.allowed) {
      throw AppError.rateLimitExceeded();
    }
    rateLimitService.consumeRateLimit(clientIp);

    // 1. Strict Zod schema validation
    const parsedRequest = AdviceRequestSchema.parse(request.body);

    // 2. PII scan on question and chat history
    const questionPii = scanPii(parsedRequest.question);
    if (questionPii.hasPii) {
      throw AppError.piiDetected();
    }

    for (const msg of parsedRequest.history) {
      const historyPii = scanPii(msg.text);
      if (historyPii.hasPii) {
        throw AppError.piiDetected();
      }
    }

    // 3. Scope validation for current question and user history items
    const questionScope = classifyAdviceScope(parsedRequest.question);
    if (questionScope.status === 'out_of_scope') {
      throw AppError.outOfScope();
    }
    if (questionScope.status === 'restricted') {
      throw AppError.restricted();
    }
    if (questionScope.status === 'ambiguous') {
      throw AppError.ambiguous();
    }

    for (const msg of parsedRequest.history) {
      if (msg.role === 'user') {
        const histScope = classifyAdviceScope(msg.text);
        if (histScope.status === 'out_of_scope') {
          throw AppError.outOfScope();
        }
        if (histScope.status === 'restricted') {
          throw AppError.restricted();
        }
      }
    }

    // 4. Intent consistency: client intent must match clear classifier topic
    if (
      questionScope.topic !== null &&
      questionScope.topic !== parsedRequest.intent
    ) {
      throw AppError.ambiguous(
        'Ý định tư vấn không khớp với nội dung câu hỏi.',
        'ADVICE_AMBIGUOUS',
      );
    }

    // 5. Quota check (only allowed requests reach this point)
    const deviceId =
      (request.headers['x-device-id'] as string | undefined) ??
      'anonymous-device';

    const quota = quotaService.checkQuota(deviceId);
    if (!quota.allowed) {
      const fallback = renderFallbackTemplate({
        intent: parsedRequest.intent,
        calculations: parsedRequest.calculations,
        summary: parsedRequest.summary,
      });
      throw AppError.quotaExceeded(
        `Bạn đã dùng hết lượt hỏi AI hôm nay. Lượt mới có từ ${quota.resetAt}.`,
        'QUOTA_EXCEEDED_DEVICE',
        fallback,
      );
    }

    // 6. Call Upstream LLM
    const upstreamRes = await upstreamAiService.callModel(parsedRequest);

    // 7. Number verification guardrail
    const allowedNumbers = extractAllowedNumbers(
      parsedRequest.summary,
      parsedRequest.calculations,
    );

    const verification = verifyNumbers(
      upstreamRes.answer,
      allowedNumbers,
      config.approxToleranceBps,
    );

    if (!verification.isValid) {
      request.log.warn(
        { violations: verification.violations },
        'AI response contained hallucinated or unverified numbers; triggering fallback template.',
      );

      const fallback = renderFallbackTemplate({
        intent: parsedRequest.intent,
        calculations: parsedRequest.calculations,
        summary: parsedRequest.summary,
      });

      throw AppError.answerUnverified(
        'Câu trả lời từ trợ lý AI chưa được xác thực số liệu an toàn. Dưới đây là kết quả tính toán từ dữ liệu của bạn.',
        fallback,
      );
    }

    // 8. Commit quota unit upon verified response
    quotaService.consumeQuota(deviceId);

    return {
      success: true,
      message: 'OK',
      code: 'OK',
      requestId: parsedRequest.requestId,
      intent: parsedRequest.intent,
      answer: upstreamRes.answer,
      calculations: parsedRequest.calculations,
      model: upstreamRes.model,
    };
  });
};