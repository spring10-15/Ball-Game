import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Replay } from "./types.js";
import {
  createInitialPlatformState,
  normalizePlatformState,
  snapshotFromPlatformState,
  type PlatformSnapshot,
  type PlatformState,
} from "./platform.js";

type StorageMode = "redis" | "local";

const DEFAULT_STATE_KEY = "agentball:platform-state";
const LOCK_SUFFIX = ":lock";
const LOCK_SECONDS = 8;
const LOCK_RETRIES = 24;
const REPLAY_DIR = "platform-replays";

interface RedisConfig {
  url: string;
  token: string;
  key: string;
}

export async function readPlatformSnapshotFromStore(): Promise<PlatformSnapshot> {
  return snapshotFromPlatformState(await readPlatformStateFromStore());
}

export async function mutatePlatformState<T>(mutator: (state: PlatformState) => T | Promise<T>): Promise<T> {
  const mode = storageMode();
  if (mode === "redis") return mutateRedisState(mutator);
  const state = readLocalState();
  const result = await mutator(state);
  writeLocalState(state);
  return result;
}

export async function readPlatformStateFromStore(): Promise<PlatformState> {
  const mode = storageMode();
  if (mode === "redis") {
    const config = redisConfig();
    const raw = await redisCommand<string | null>(config, ["GET", config.key]);
    if (!raw) return createInitialPlatformState();
    return parseState(raw);
  }
  return readLocalState();
}

export async function savePlatformReplayToStore(replay: Replay): Promise<void> {
  const mode = storageMode();
  if (mode === "redis") {
    const config = redisConfig();
    await redisCommand(config, ["SET", replayKey(config.key, replay.matchId), JSON.stringify(replay)]);
    return;
  }
  writeLocalReplay(replay);
}

export async function readPlatformReplayFromStore(matchId: string): Promise<Replay | null> {
  const mode = storageMode();
  if (mode === "redis") {
    const config = redisConfig();
    const raw = await redisCommand<string | null>(config, ["GET", replayKey(config.key, matchId)]);
    return raw ? JSON.parse(raw) as Replay : null;
  }
  return readLocalReplay(matchId);
}

export async function cleanupPlatformReplaysFromStore(options: {
  keepMatchIds: string[];
  cursor?: string;
  count?: number;
  limit?: number;
}): Promise<{
  deleted: number;
  kept: number;
  scanned: number;
  cursor: string;
  done: boolean;
}> {
  const keep = new Set(options.keepMatchIds);
  const mode = storageMode();
  if (mode === "redis") {
    const config = redisConfig();
    const prefix = replayKeyPrefix(config.key);
    const count = Math.max(1, Math.min(Math.floor(options.count ?? 50), 200));
    const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 50), 200));
    let cursor = options.cursor ?? "0";
    let deleted = 0;
    let kept = 0;
    let scanned = 0;
    do {
      const result = await redisCommand<[string, string[]]>(config, ["SCAN", cursor, "MATCH", `${prefix}*`, "COUNT", String(count)]);
      cursor = String(result[0] ?? "0");
      const keys = Array.isArray(result[1]) ? result[1] : [];
      scanned += keys.length;
      const staleKeys = keys.filter((key) => {
        const matchId = key.slice(prefix.length);
        const shouldKeep = keep.has(matchId);
        if (shouldKeep) kept += 1;
        return !shouldKeep;
      });
      if (staleKeys.length > 0) {
        const batch = staleKeys.slice(0, limit - deleted);
        await redisCommand(config, ["DEL", ...batch]);
        deleted += batch.length;
      }
    } while (cursor !== "0" && deleted < limit);
    return { deleted, kept, scanned, cursor, done: cursor === "0" };
  }
  const cleanup = cleanupLocalReplays(keep);
  return { ...cleanup, cursor: "0", done: true };
}

async function mutateRedisState<T>(mutator: (state: PlatformState) => T | Promise<T>): Promise<T> {
  const config = redisConfig();
  const lockToken = await acquireRedisLock(config);
  try {
    const raw = await redisCommand<string | null>(config, ["GET", config.key]);
    const state = raw ? parseState(raw) : createInitialPlatformState();
    const result = await mutator(state);
    await redisCommand(config, ["SET", config.key, JSON.stringify(normalizePlatformState(state))]);
    return result;
  } finally {
    await releaseRedisLock(config, lockToken);
  }
}

async function acquireRedisLock(config: RedisConfig): Promise<string> {
  const token = randomUUID();
  const lockKey = `${config.key}${LOCK_SUFFIX}`;
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    const result = await redisCommand<string | null>(config, ["SET", lockKey, token, "NX", "EX", String(LOCK_SECONDS)]);
    if (result === "OK") return token;
    await delay(60 + attempt * 20);
  }
  throw new Error("系统繁忙：平台状态正在写入，请稍后重试");
}

async function releaseRedisLock(config: RedisConfig, token: string): Promise<void> {
  const lockKey = `${config.key}${LOCK_SUFFIX}`;
  const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
  try {
    await redisCommand(config, ["EVAL", script, "1", lockKey, token]);
  } catch {
    // 锁有过期时间；释放失败时不影响下一次请求，只会短暂延迟并发写入。
  }
}

async function redisCommand<T>(config: RedisConfig, command: string[]): Promise<T> {
  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  const payload = (await response.json().catch(() => ({}))) as { result?: T; error?: string };
  if (!response.ok || payload.error) {
    throw new Error(`Redis 存储请求失败：${payload.error ?? response.statusText}`);
  }
  return payload.result as T;
}

function storageMode(): StorageMode {
  if (hasRedisConfig()) return "redis";
  if (process.env.VERCEL === "1" || process.env.AGENTBALL_STORAGE_MODE === "redis") {
    throw new Error("生产环境未配置持久化存储：请设置 KV_REST_API_URL/KV_REST_API_TOKEN 或 UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN");
  }
  return "local";
}

function redisConfig(): RedisConfig {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error("缺少 Redis/KV 环境变量");
  }
  return {
    url,
    token,
    key: process.env.AGENTBALL_REDIS_KEY ?? DEFAULT_STATE_KEY,
  };
}

function hasRedisConfig(): boolean {
  return Boolean(
    (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) ||
      (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN),
  );
}

function readLocalState(): PlatformState {
  try {
    return parseState(readFileSync(localStateFile(), "utf8"));
  } catch {
    const state = createInitialPlatformState();
    writeLocalState(state);
    return state;
  }
}

function writeLocalState(state: PlatformState): void {
  const file = localStateFile();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(normalizePlatformState(state), null, 2));
}

function writeLocalReplay(replay: Replay): void {
  const file = localReplayFile(replay.matchId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(replay));
}

function readLocalReplay(matchId: string): Replay | null {
  try {
    return JSON.parse(readFileSync(localReplayFile(matchId), "utf8")) as Replay;
  } catch {
    return null;
  }
}

function cleanupLocalReplays(keep: Set<string>): { deleted: number; kept: number; scanned: number } {
  const dir = path.join(process.cwd(), "data", REPLAY_DIR);
  let deleted = 0;
  let kept = 0;
  let scanned = 0;
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      scanned += 1;
      const matchId = file.slice(0, -5);
      if (keep.has(matchId)) {
        kept += 1;
        continue;
      }
      unlinkSync(path.join(dir, file));
      deleted += 1;
    }
  } catch {
    return { deleted, kept, scanned };
  }
  return { deleted, kept, scanned };
}

function parseState(raw: string): PlatformState {
  const parsed = JSON.parse(raw) as PlatformState;
  if (parsed.schemaVersion !== 1) throw new Error("平台状态版本不受支持");
  return normalizePlatformState(parsed);
}

function localStateFile(): string {
  return path.join(process.cwd(), "data", "platform-state.json");
}

function localReplayFile(matchId: string): string {
  const safeMatchId = matchId.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(process.cwd(), "data", REPLAY_DIR, `${safeMatchId}.json`);
}

function replayKey(stateKey: string, matchId: string): string {
  return `${replayKeyPrefix(stateKey)}${matchId}`;
}

function replayKeyPrefix(stateKey: string): string {
  return `${stateKey}:replay:`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
