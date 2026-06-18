import type { IncomingMessage, ServerResponse } from "node:http";

import handler from "../../server/api-handler.js";

export default function platformAction(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = url.searchParams.get("route");
  const matchId = url.searchParams.get("matchId");
  if (route === "eventJoin") req.url = "/api/platform/events/join";
  if (route === "matches") req.url = "/api/platform/matches";
  if (route === "strategyPreview") req.url = "/api/platform/balls/strategy-preview";
  if (route === "replay" && matchId) req.url = `/api/platform/replays/${matchId}`;
  if (route === "eventRound") req.url = "/api/cron/event-round";
  if (route === "cleanupReplays") {
    url.searchParams.delete("route");
    const query = url.searchParams.toString();
    req.url = `/api/cron/cleanup-replays${query ? `?${query}` : ""}`;
  }
  return handler(req, res);
}
