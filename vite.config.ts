import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import apiHandler from "./api/[...path].js";
import { runEvaluation, writeEvaluation } from "./core/evaluate.js";
import {
  agentTuneBall,
  createUserBall,
  getPlatformSnapshot,
  runPlatformBattle,
  updateBallAppearance,
} from "./core/platform.js";
import { runDemoAndWrite } from "./core/run-sim.js";
import { runDemoMatch } from "./core/run-sim.js";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "agentball-local-api",
      configureServer(server) {
        server.middlewares.use("/api/auth", async (req, res) => {
          req.url = `/api/auth${req.url === "/" ? "" : req.url ?? ""}`;
          await apiHandler(req as never, res as never);
        });

        server.middlewares.use("/api/platform", async (req, res) => {
          req.url = `/api/platform${req.url === "/" ? "" : req.url ?? ""}`;
          await apiHandler(req as never, res as never);
        });

        server.middlewares.use("/api/agent", async (req, res) => {
          req.url = `/api/agent${req.url === "/" ? "" : req.url ?? ""}`;
          await apiHandler(req as never, res as never);
        });

        server.middlewares.use("/api/replay", async (req, res) => {
          req.url = `/api/replay${req.url === "/" ? "" : req.url ?? ""}`;
          await apiHandler(req as never, res as never);
        });

        server.middlewares.use("/api/platform", async (req, res) => {
          try {
            const route = req.url?.split("?")[0] ?? "/";
            if (req.method === "GET" && route === "/") {
              sendJson(res, 200, getPlatformSnapshot());
              return;
            }
            if (req.method === "POST" && route === "/balls") {
              sendJson(res, 200, createUserBall(await readJsonBody(req)));
              return;
            }
            if (req.method === "PATCH" && route === "/balls/appearance") {
              const body = await readJsonBody(req);
              sendJson(res, 200, updateBallAppearance({
                ballId: requiredString(body.ballId, "ballId"),
                name: optionalString(body.name),
                motto: optionalString(body.motto),
                appearance: optionalObject(body.appearance),
              }));
              return;
            }
            if (req.method === "POST" && route === "/matches") {
              const result = runPlatformBattle(await readJsonBody(req));
              sendJson(res, 200, result);
              return;
            }
            sendJson(res, 404, { error: "没有找到这个开放接口" });
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
          }
        });

        server.middlewares.use("/api/agent/tune-ball", async (req, res) => {
          await handleAgentBallEdit(req, res);
        });

        server.middlewares.use("/api/agent/ball-edit-upload", async (req, res) => {
          await handleAgentBallEdit(req, res);
        });

        async function handleAgentBallEdit(
          req: { method?: string; on: (event: string, cb: (chunk?: Buffer) => void) => void },
          res: { statusCode: number; setHeader: (name: string, value: string) => void; end: (body: string) => void },
        ) {
          if (req.method !== "POST") {
            sendJson(res, 405, { error: "请求方法不支持" });
            return;
          }
          try {
            const body = await readJsonBody(req);
            if (body.actor !== "agent") {
              sendJson(res, 403, { error: "只有 Agent 可以修改内部设定" });
              return;
            }
            sendJson(res, 200, agentTuneBall({
              ballId: requiredString(body.ballId, "ballId"),
              profile: optionalString(body.profile) as never,
              editRule: optionalString(body.editRule),
              actor: optionalString(body.actor),
            }));
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
          }
        }

        server.middlewares.use("/api/run-sim", async (req, res) => {
          if (req.method !== "POST") {
            sendJson(res, 405, { error: "请求方法不支持" });
            return;
          }
          try {
            const body = await readJsonBody(req);
            const seed = positiveIntOr(body.seed, Math.floor(Date.now() % 100000), "seed");
            const durationSeconds = positiveIntOr(body.durationSeconds, 60, "durationSeconds");
            const result = runDemoAndWrite({ seed, durationSeconds, matchId: `demo_${seed}` });
            sendJson(res, 200, {
              replay: result.replay,
              paths: result.paths,
            });
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
          }
        });

        server.middlewares.use("/api/run-eval", async (req, res) => {
          if (req.method !== "POST") {
            sendJson(res, 405, { error: "请求方法不支持" });
            return;
          }
          try {
            const body = await readJsonBody(req);
            const args = {
              matches: positiveIntOr(body.matches, 30, "matches"),
              duration: positiveIntOr(body.duration, 60, "duration"),
              seedStart: positiveIntOr(body.seedStart, 1000, "seedStart"),
            };
            const summary = runEvaluation(args);
            const outPath = writeEvaluation(summary);
            sendJson(res, 200, { summary, outPath });
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
          }
        });
      },
    },
  ],
  publicDir: "out",
  server: {
    port: 5173,
  },
});

function readJsonBody(req: { on: (event: string, cb: (chunk?: Buffer) => void) => void }): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk?: Buffer) => {
      if (chunk) chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function positiveIntOr(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return n;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`缺少字段：${name}`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function sendJson(res: { statusCode: number; setHeader: (name: string, value: string) => void; end: (body: string) => void }, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}
