import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';

import { config } from './config';
import { errorHandler } from './middleware/error-handler';
import { adviceRoutes } from './routes/advice';
import { plannedAdviceRoutes } from './routes/planned-advice';
import { healthRoutes } from './routes/health';
import { quotaRoutes } from './routes/quota';
import { receiptRoutes } from './routes/receipt';

// Build the Fastify application instance.
export function buildApp(opts: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify({
    bodyLimit: config.maxBodyBytes,
    ...opts,
  });

  // Support CORS for web development and cross-origin mobile clients
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header(
      'Access-Control-Allow-Methods',
      'GET, POST, PUT, DELETE, OPTIONS',
    );
    reply.header(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, x-device-id',
    );
    if (request.method === 'OPTIONS') {
      return reply.status(204).send();
    }
  });

  // Global centralized error handler
  app.setErrorHandler(errorHandler);

  // Register API routes
  app.register(healthRoutes);
  app.register(quotaRoutes);
  app.register(adviceRoutes);
  app.register(plannedAdviceRoutes);
  app.register(receiptRoutes);

  return app;
}
