import type { FastifyInstance } from 'fastify';
import { AppError } from '../errors/app-error';
import { parseByokHeaders } from '../services/byok';
import { upstreamAiService } from '../services/upstream-ai';

export async function byokRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/byok/test', async (request) => {
    const byok = parseByokHeaders(
      request.headers as Record<string, string | string[] | undefined>,
    );
    if (!byok) {
      throw AppError.badRequest(
        'Vui lòng cung cấp đầy đủ Base URL, Model và API Key để kiểm tra.',
      );
    }
    const result = await upstreamAiService.testByokConnection(byok);
    return { ok: true, model: result.model };
  });
}
