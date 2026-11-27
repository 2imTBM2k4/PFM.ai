import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';

import { config } from './config';
import { errorHandler } from './middleware/error-handler';
import { adviceRoutes } from './routes/advice';
import { plannedAdviceRoutes } from './routes/planned-advice';
import { agentAdviceRoutes } from './routes/agent-advice';
import { coachAdviceRoutes } from './routes/coach-advice';
import { healthRoutes } from './routes/health';
import { quotaRoutes } from './routes/quota';
import { receiptRoutes } from './routes/receipt';
import { byokRoutes } from './routes/byok';
import { installAILogging, auditDestination } from './middleware/logging';
import { installAIRateLimit } from './middleware/rate-limit';
import { authenticateGoogle } from './middleware/auth';

// Build the Fastify application instance.
export function buildApp(opts: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify({
    bodyLimit: config.maxBodyBytes,
    ...opts,
    logController: new LogController({ disableRequestLogging: true }),
    logger:
      opts.logger === false || !opts.logger
        ? false
        : {
            ...(typeof opts.logger === 'object' ? opts.logger : {}),
            base: null,
            timestamp: false,
            stream: auditDestination(
              typeof opts.logger === 'object' &&
                'stream' in opts.logger &&
                opts.logger.stream
                ? opts.logger.stream
                : process.stdout,
            ),
          },
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
      'Content-Type, Authorization, x-device-id, ngrok-skip-browser-warning, x-byok-base-url, x-byok-api-key, x-byok-model',
    );
    if (request.method === 'OPTIONS') {
      return reply.status(204).send();
    }
  });

  // Global centralized error handler
  installAILogging(app);
  installAIRateLimit(app);
  app.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions.url?.startsWith('/v1/'))
      await authenticateGoogle(request, reply);
  });
  app.setErrorHandler(errorHandler);

  // Register API routes
  app.register(healthRoutes);
  app.register(quotaRoutes);
  app.register(adviceRoutes);
  app.register(plannedAdviceRoutes);
  app.register(agentAdviceRoutes);
  app.register(coachAdviceRoutes);
  app.register(receiptRoutes);
  app.register(byokRoutes);

  return app;
}
