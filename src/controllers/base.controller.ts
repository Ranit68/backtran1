import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { formatZodError } from "../models/request.schemas.js";
import { env } from "../config/env.js";
import { AppError, ErrorCode } from "../utils/errors.js";
import { sendFail, sendOk } from "../utils/response.js";

/**
 * Controller helpers.
 *
 * Controllers stay deliberately thin: parse and validate, call a service, send
 * the standard envelope. Every handler funnels failures through `handle` so the
 * error shape is identical everywhere (spec section 23).
 */

export function parseOrThrow<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      "The request could not be validated.",
      formatZodError(result.error),
    );
  }
  return result.data;
}

export async function handle(
  reply: FastifyReply,
  operation: () => Promise<unknown> | unknown,
  statusCode = 200,
): Promise<FastifyReply> {
  try {
    const data = await operation();
    return sendOk(reply, data, statusCode);
  } catch (error) {
    if (error instanceof AppError) {
      return sendFail(reply, error.code, error.message, error.statusCode, error.details);
    }
    // Not an AppError: rethrow so the global error handler logs it with a stack
    // trace instead of flattening an unexpected bug into a clean 400.
    throw error;
  }
}

/**
 * Guards the administrative routes (spec section 25).
 *
 * Fails CLOSED: with no ADMIN_KEY configured the routes return 503 rather than
 * defaulting to open, because these endpoints can rebuild the graph and write
 * to the database.
 */
export function assertAdminKey(provided: string | undefined): void {
  if (!env.ADMIN_KEY) {
    throw new AppError(
      ErrorCode.ADMIN_AUTH_REQUIRED,
      "Administrative endpoints are disabled because ADMIN_KEY is not set. Set it in .env to enable them.",
    );
  }
  if (provided !== env.ADMIN_KEY) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      "Invalid or missing x-admin-key header.",
      undefined,
      401,
    );
  }
}

export function readAdminKey(request: FastifyRequest): string | undefined {
  const header = request.headers["x-admin-key"];
  return Array.isArray(header) ? header[0] : header;
}
