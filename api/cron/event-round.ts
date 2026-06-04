import type { IncomingMessage, ServerResponse } from "node:http";

import { runNextPlatformEventRoundInState } from "../../core/platform.js";
import { mutatePlatformState, savePlatformReplayToStore } from "../../core/platform-storage.js";

interface ApiResponse extends ServerResponse {
  status?: (code: number) => ApiResponse;
  json?: (body: unknown) => void;
}

export default async function eventRoundCron(req: IncomingMessage, res: ApiResponse) {
  setJsonHeaders(res);

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "只允许 GET" });
    return;
  }

  const authError = validateCronAuth(req);
  if (authError) {
    sendJson(res, authError.status, { error: authError.message });
    return;
  }

  try {
    const result = await mutatePlatformState((state) => runNextPlatformEventRoundInState(state, new Date()));
    if (!result) {
      sendJson(res, 200, { ok: true, ran: false });
      return;
    }

    await savePlatformReplayToStore(result.replay);
    sendJson(res, 200, {
      ok: true,
      ran: true,
      matchId: result.match.matchId,
      roundIndex: result.match.roundIndex,
      participantCount: result.match.results.length,
      winnerBallId: result.match.winnerBallId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, /系统繁忙/.test(message) ? 409 : 500, { error: message });
  }
}

function validateCronAuth(req: IncomingMessage): { status: number; message: string } | null {
  const secret = process.env.CRON_SECRET;
  const isVercel = process.env.VERCEL === "1";
  if (!secret) {
    return isVercel ? { status: 500, message: "生产环境缺少 CRON_SECRET" } : null;
  }
  return req.headers.authorization === `Bearer ${secret}` ? null : { status: 401, message: "Unauthorized" };
}

function setJsonHeaders(res: ServerResponse) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
}

function sendJson(res: ApiResponse, status: number, body: unknown) {
  if (typeof res.status === "function" && typeof res.json === "function") {
    res.status(status).json?.(body);
    return;
  }
  res.statusCode = status;
  res.end(JSON.stringify(body));
}
