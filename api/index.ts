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
  const app = await getApp();
  app.server.emit("request", request, response);
}
