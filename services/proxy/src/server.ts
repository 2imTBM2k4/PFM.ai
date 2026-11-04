import { buildApp } from './app';
import { config } from './config';

const app = buildApp({
  logger: {
    level: config.nodeEnv === 'production' ? 'info' : 'debug',
    redact: [
      'req.headers.authorization',
      'req.body.question',
      'req.body.summary',
      'req.body.imageBase64',
    ],
  },
});

const start = async () => {
  try {
    await app.listen({ port: config.port, host: config.host });
    console.log(
      `PFM.ai Proxy service running at http://${config.host}:${config.port}`,
    );
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
