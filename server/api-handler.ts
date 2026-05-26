import type { IncomingMessage, ServerResponse } from "node:http";

import {
  currentUserFromCookie,
  logoutSession,
  requestEmailCode,
  verifyEmailCode,
  type AuthUser,
} from "../core/auth.js";
import { runEvaluation } from "../core/evaluate.js";
import {
  agentTuneBallInState,
  createUserBallInState,
  deleteUserBallInState,
  runPlatformBattleInState,
  updateBallAppearanceInState,
  type AgentProfile,
  type BallAppearance,
  type BallSkill,
  type RunPlatformBattleInput,
} from "../core/platform.js";
import { mutatePlatformState, readPlatformSnapshotFromStore } from "../core/platform-storage.js";
import { runDemoMatch } from "../core/run-sim.js";

interface ApiRequest extends IncomingMessage {
  body?: unknown;
}

interface ApiResponse extends ServerResponse {
  status?: (code: number) => ApiResponse;
  json?: (body: unknown) => void;
}

class RequestError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  setCommonHeaders(res);
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  try {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const route = pathname.replace(/^\/api/, "") || "/";

    if (req.method === "GET" && route === "/auth/me") {
      sendJson(res, 200, { user: await currentUserFromCookie(req.headers.cookie) });
      return;
    }

    if (req.method === "POST" && route === "/auth/request-code") {
      const body = await readJsonBody(req);
      sendJson(res, 200, await requestEmailCode(requiredString(body.email, "email")));
      return;
    }

    if (req.method === "POST" && route === "/auth/verify-code") {
      const body = await readJsonBody(req);
      const result = await verifyEmailCode(requiredString(body.email, "email"), requiredString(body.code, "code"));
      res.setHeader("Set-Cookie", result.cookie);
      sendJson(res, 200, { user: result.user });
      return;
    }

    if (req.method === "POST" && route === "/auth/logout") {
      res.setHeader("Set-Cookie", await logoutSession(req.headers.cookie));
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && route === "/platform") {
      sendJson(res, 200, await readPlatformSnapshotFromStore());
      return;
    }

    if (req.method === "GET" && route === "/replay/demo") {
      sendJson(res, 200, runDemoMatch({ seed: 42, durationSeconds: 60, matchId: "demo_42" }));
      return;
    }

    if (req.method === "POST" && route === "/run-sim") {
      const body = await readJsonBody(req);
      sendJson(res, 200, {
        replay: runDemoMatch({
          seed: optionalPositiveInt(body.seed, "seed", 99999999) ?? Math.floor(Date.now() % 100000),
          durationSeconds: optionalPositiveInt(body.durationSeconds, "durationSeconds", 90) ?? 60,
        }),
      });
      return;
    }

    if (req.method === "POST" && route === "/run-eval") {
      const body = await readJsonBody(req);
      sendJson(res, 200, {
        summary: runEvaluation({
          matches: optionalPositiveInt(body.matches, "matches", 100) ?? 30,
          duration: optionalPositiveInt(body.duration, "duration", 90) ?? 60,
          seedStart: optionalPositiveInt(body.seedStart, "seedStart", 99999999) ?? 1000,
        }),
      });
      return;
    }

    if (req.method === "POST" && route === "/platform/balls") {
      const user = await requireAuth(req);
      const body = await readJsonBody(req);
      const snapshot = await mutatePlatformState((state) => createUserBallInState(state, {
        ownerId: user.userId,
        ownerName: optionalString(body.ownerName) ?? user.displayName,
        name: optionalString(body.name),
        motto: optionalString(body.motto),
        appearance: optionalObject(body.appearance) as Partial<BallAppearance> | undefined,
      }));
      sendJson(res, 200, snapshot);
      return;
    }

    if (req.method === "PATCH" && route === "/platform/balls/appearance") {
      const user = await requireAuth(req);
      const body = await readJsonBody(req);
      const ballId = requiredString(body.ballId, "ballId");
      const snapshot = await mutatePlatformState((state) => {
        const ball = state.balls.find((item) => item.ballId === ballId);
        if (!ball) throw new RequestError("没有找到这个球球", 404);
        if (ball.ownerId !== user.userId) throw new RequestError("只能编辑自己的球球", 403);
        return updateBallAppearanceInState(state, {
          ballId,
          name: optionalString(body.name),
          motto: optionalString(body.motto),
          appearance: optionalObject(body.appearance) as Partial<BallAppearance> | undefined,
        });
      });
      sendJson(res, 200, snapshot);
      return;
    }

    if (req.method === "DELETE" && route === "/platform/balls") {
      const user = await requireAuth(req);
      const body = await readJsonBody(req);
      const ballId = requiredString(body.ballId, "ballId");
      const snapshot = await mutatePlatformState((state) => {
        const ball = state.balls.find((item) => item.ballId === ballId);
        if (!ball) throw new RequestError("没有找到这个球球", 404);
        if (ball.ownerId !== user.userId) throw new RequestError("只能删除自己的球球", 403);
        return deleteUserBallInState(state, ballId);
      });
      sendJson(res, 200, snapshot);
      return;
    }

    if (req.method === "POST" && route === "/platform/matches") {
      await requireAuth(req);
      const body = await readJsonBody(req);
      const input: RunPlatformBattleInput = {
        seed: optionalPositiveInt(body.seed, "seed", 99999999),
        durationSeconds: optionalPositiveInt(body.durationSeconds, "durationSeconds", 90),
        ballIds: optionalStringArray(body.ballIds, "ballIds", 8),
      };
      const result = await mutatePlatformState((state) => runPlatformBattleInState(state, input));
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && (route === "/agent/tune-ball" || route === "/agent/ball-edit-upload")) {
      const body = await readJsonBody(req);
      if (body.actor !== "agent") {
        throw new RequestError("只有 Agent 可以修改内部设定", 403);
      }
      const snapshot = await mutatePlatformState((state) => agentTuneBallInState(state, {
        ballId: requiredString(body.ballId, "ballId"),
        profile: optionalProfile(body.profile),
        skill: optionalSkill(body.skill),
        editRule: optionalString(body.editRule),
        actor: optionalString(body.actor),
      }));
      sendJson(res, 200, snapshot);
      return;
    }

    sendJson(res, 404, { error: "没有找到这个开放接口" });
  } catch (error) {
    const status = error instanceof RequestError ? error.status : statusForError(error);
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, status, { error: message });
  }
}

async function readJsonBody(req: ApiRequest): Promise<Record<string, unknown>> {
  if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
    return req.body as Record<string, unknown>;
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    totalBytes += buffer.byteLength;
    if (totalBytes > 64 * 1024) throw new RequestError("请求体过大", 413);
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new RequestError("请求体必须是 JSON");
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new RequestError(`缺少字段：${name}`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function optionalStringArray(value: unknown, name: string, maxLength: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new RequestError(`${name} 必须是字符串数组`);
  const items = value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
  if (items.length > maxLength) throw new RequestError(`${name} 最多只能包含 ${maxLength} 个球球`);
  return items;
}

function optionalPositiveInt(value: unknown, name: string, max: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new RequestError(`${name} 必须是正整数`);
  if (n > max) throw new RequestError(`${name} 不能超过 ${max}`);
  return n;
}

function optionalProfile(value: unknown): AgentProfile | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "balanced" || value === "conservative" || value === "greedy") return value;
  throw new RequestError("未知的智能体托管档位");
}

function optionalSkill(value: unknown): BallSkill | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "none" || value === "forage" || value === "evade" || value === "dash") return value;
  throw new RequestError("未知的球球专属技能");
}

async function requireAuth(req: ApiRequest): Promise<AuthUser> {
  const user = await currentUserFromCookie(req.headers.cookie);
  if (!user) throw new RequestError("请先用邮箱登录", 401);
  return user;
}

function setCommonHeaders(res: ApiResponse) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", process.env.AGENTBALL_ALLOWED_ORIGIN ?? "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

function statusForError(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (/最多|缺少|未知|没有找到|至少需要|必须|不能超过|过大/.test(message)) return 400;
  if (/系统繁忙/.test(message)) return 409;
  return 500;
}

function sendJson(res: ApiResponse, status: number, body: unknown) {
  const statusFn = res.status;
  const jsonFn = res.json;
  if (typeof statusFn === "function" && typeof jsonFn === "function") {
    statusFn.call(res, status).json?.(body);
    return;
  }
  res.statusCode = status;
  res.end(JSON.stringify(body));
}
