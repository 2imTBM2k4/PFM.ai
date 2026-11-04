import type { FastifyPluginAsync } from 'fastify';

import { quotaService } from '../services/quota-service';

export const quotaRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/v1/quota', async (request) => {
    const deviceId =
      (request.headers['x-device-id'] as string | undefined) ??
      'anonymous-device';

    const status = quotaService.checkQuota(deviceId);

    return {
      success: true,
      message: 'OK',
      code: 'OK',
      data: status,
    };
  });
};
