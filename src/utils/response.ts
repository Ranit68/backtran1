import type { FastifyReply } from "fastify";
import type { ApiErrorBody, ApiSuccessBody } from "../types/transport.js";
import { AppError, ErrorCode } from "./errors.js";

/** Success envelope -- specification section 23. */
export function ok<T>(data: T): ApiSuccessBody<T> {
  return { success: true, data };
}

/** Error envelope -- specification section 23. */
export function fail(code: string, message: string, details?: unknown): ApiErrorBody {
  return {
    success: false,
    error: details === undefined ? { code, message } : { code, message, details },
  };
}

export function sendOk<T>(reply: FastifyReply, data: T, statusCode = 200): FastifyReply {
  return reply.status(statusCode).send(ok(data));
}

/**
 * Sends a non-2xx response that still uses the standard success/error
 * envelope, so clients never have to branch on response shape.
 */
export function sendFail(
  reply: FastifyReply,
  code: string,
  message: string,
  statusCode: number,
  details?: unknown,
): FastifyReply {
  return reply.status(statusCode).send(fail(code, message, details));
}

export function sendAppError(reply: FastifyReply, error: AppError): FastifyReply {
  return sendFail(reply, error.code, error.message, error.statusCode, error.details);
}

export { ErrorCode };
