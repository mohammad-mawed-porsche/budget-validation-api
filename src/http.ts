import type { FastifyReply } from "fastify";
import { z } from "zod";

export function sendApiError(
  reply: FastifyReply,
  statusCode: number,
  requestId: string,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
) {
  return reply.code(statusCode).send({ error: { code, message, ...details, requestId } });
}

export function sendValidationError(reply: FastifyReply, requestId: string, error: z.ZodError) {
  return sendApiError(reply, 400, requestId, "INVALID_REQUEST", z.prettifyError(error));
}

