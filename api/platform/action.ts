import type { IncomingMessage, ServerResponse } from "node:http";

import handler from "../../server/api-handler.js";

export default function platformAction(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = url.searchParams.get("route");
  if (route === "eventJoin") req.url = "/api/platform/events/join";
  if (route === "matches") req.url = "/api/platform/matches";
  return handler(req, res);
}
