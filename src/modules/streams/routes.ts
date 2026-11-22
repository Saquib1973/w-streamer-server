import { Router } from "express";
import { ResolveStreamBody, StreamsQuery, type ApiResponses } from "../../contracts/api.js";
import { authenticate, ctx, requireProfile } from "../../middleware/auth.js";
import { param, parseBody, parseQuery } from "../../middleware/validate.js";
import * as svc from "./service.js";

export const streamsRouter = Router();
streamsRouter.use(authenticate, requireProfile);

const viewer = (req: Parameters<typeof ctx>[0]) => {
  const c = ctx(req);
  return { ownerId: c.ownerId, profileId: c.profile.id, policy: c.policy, userId: c.userId };
};

streamsRouter.get("/streams/:type/:videoId", async (req, res) => {
  const q = parseQuery(StreamsQuery, req);
  const out: ApiResponses["GET /streams/:type/:videoId"] = await svc.listStreams(viewer(req), param(req, "type"), param(req, "videoId"), q);
  res.json(out);
});

streamsRouter.get("/subtitles/:type/:videoId", async (req, res) => {
  const out: ApiResponses["GET /subtitles/:type/:videoId"] = { subtitles: await svc.listSubtitles(viewer(req), param(req, "type"), param(req, "videoId")) };
  res.json(out);
});

streamsRouter.post("/resolve", async (req, res) => {
  const body = parseBody(ResolveStreamBody, req);
  const v = viewer(req);
  const out: ApiResponses["POST /resolve"] = await svc.resolve(v, v.userId, body);
  res.json(out);
});
