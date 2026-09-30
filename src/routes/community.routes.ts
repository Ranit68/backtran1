import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";
import {
  getCommunityFeed,
  postCommunityReport,
} from "../controllers/community.controller.js";

/**
 * Route-scoped community routes.
 *
 * The write limit is much stricter than the global one, and it is on the write
 * path only. The global limit exists to stop a client from hammering read
 * endpoints; it is meaningless here, because what needs protecting is not the
 * server's capacity but the feed other riders have to read. The defaults in
 * env.ts allow roughly "someone typing a few reports as they travel", which is
 * the honest upper bound of real use, and are slow enough that a script cannot
 * matter. Reads stay on the global limit.
 */
export async function communityRoutes(app: FastifyInstance): Promise<void> {
  app.get("/community/:mode/:route", getCommunityFeed);

  app.post(
    "/community/:mode/:route",
    {
      config: {
        rateLimit: {
          max: env.COMMUNITY_POST_RATE_LIMIT_MAX,
          timeWindow: env.COMMUNITY_POST_RATE_LIMIT_WINDOW,
        },
      },
    },
    postCommunityReport,
  );
}
