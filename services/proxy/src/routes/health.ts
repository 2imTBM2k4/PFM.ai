import type { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/healthz', async () => {
    return {
      success: true,
      message: 'OK',
      code: 'OK',
      uptime: process.uptime(),
    };
  });
};
