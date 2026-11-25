import { authUserId } from '../middleware/auth';
import type { FastifyPluginAsync } from 'fastify';

import { quotaService } from '../services/quota-service';

export const quotaRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/v1/quota', async (request) => {
    const deviceId = authUserId(request.auth);

    const status = quotaService.checkQuota(deviceId, request.auth.mode);

    return {
      success: true,
      message: 'OK',
      code: 'OK',
      data: status,
    };
  });
};
