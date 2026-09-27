import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

/**
 * Vercel serverless entry point.
 *
 * Vercel invokes the default export with the raw Node (req, res) pair. The
 * Fastify instance is built once and cached on `globalThis`, so warm
 * invocations reuse the same instance, the same in-process transport graph and
 * the same Postgres pool rather than rebuilding all three per request.
 *
 * `app.server.emit("request", req, res)` is the supported way to hand Vercel's
 * request to Fastify without binding a port.
 */

const globalRef = globalThis as typeof globalThis & { __transportApp?: Promise<FastifyInstance> };

function getApp(): Promise<FastifyInstance> {
  if (!globalRef.__transportApp) {
    globalRef.__transportApp = buildApp().then(async (app) => {
      await app.ready();
      return app;
    });
  }
  return globalRef.__transportApp;
}

export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const app = await getApp();
    app.server.emit("request", request, response);
  } catch (error) {
    // Without this the runtime discards the failure and returns an empty 500,
    // which says nothing about the cause. Logging puts it in the function logs
    // and the body makes it visible to whoever is holding the request.
    console.error("request failed before a response was produced", {
      url: request.url,
      method: request.method,
      err: error instanceof Error ? { message: error.message, stack: error.stack } : error,
    });
    if (!response.headersSent) {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json; charset=utf-8");
    }
    response.end(
      JSON.stringify({
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          statusCode: 500,
          message: error instanceof Error ? error.message : "Unhandled server error",
        },
      }),
    );
  }
}
