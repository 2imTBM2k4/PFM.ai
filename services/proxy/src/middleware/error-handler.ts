import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import { AppError } from '../errors/app-error';

// Central error-handling middleware standardizing all HTTP responses.
export function errorHandler(
  error: FastifyError | AppError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (error instanceof AppError) {
    reply.status(error.statusCode).send({
      success: false,
      message: error.message,
      code: error.code,
      ...(error.fallbackTemplate ? { fallbackTemplate: error.fallbackTemplate } : {}),
    });
    return;
  }

  if (error instanceof ZodError) {
    reply.status(400).send({
      success: false,
      message: 'Dữ liệu yêu cầu không hợp lệ.',
      code: 'BAD_REQUEST',
      errors: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return;
  }

  // Fastify payload/schema errors
  if ('statusCode' in error && typeof error.statusCode === 'number') {
    reply.status(error.statusCode).send({
      success: false,
      message: error.message,
      code: 'BAD_REQUEST',
    });
    return;
  }

  // Unhandled internal server error (never leak raw error stack or payload to client)
  request.log.error(error);
  reply.status(500).send({
    success: false,
    message: 'Đã xảy ra lỗi nội bộ máy chủ.',
    code: 'INTERNAL_ERROR',
  });
}
