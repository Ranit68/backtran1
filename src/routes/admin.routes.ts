import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  adminStatus,
  createRouteAlias,
  listRouteAliases,
  refreshTransportGraph,
} from "../controllers/admin.controller.js";
import { assertAdminKey, readAdminKey } from "../controllers/base.controller.js";

/**
 * Administrative routes.
 *
 * Gated by ADMIN_KEY (spec section 25: never expose database credentials, and
 * do not let anyone trigger a graph rebuild on demand).
 */
function adminGuard(request: FastifyRequest, reply: FastifyReply, done: (error?: Error) => void): void {
  try {
    assertAdminKey(readAdminKey(request));
    done();
  } catch (error) {
    // The central error handler renders this into the standard error envelope.
    done(error as Error);
  }
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/status", adminStatus);
  // The route generic is declared here rather than inferred from the handler,
  // which is what keeps the handler's request type assignable when a
  // preHandler option object is also present.
  app.get<{ Querystring: { mode?: string } }>(
    "/admin/routes/aliases",
    { preHandler: adminGuard },
    listRouteAliases,
  );
  app.post<{ Body: unknown }>(
    "/admin/routes/alias",
    { preHandler: adminGuard },
    createRouteAlias,
  );
  app.post<{ Querystring: unknown }>(
    "/admin/graph/refresh",
    { preHandler: adminGuard },
    refreshTransportGraph,
  );
}
