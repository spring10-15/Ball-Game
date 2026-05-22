import { createHmac, randomBytes, randomInt } from "node:crypto";

import { mutatePlatformState, readPlatformStateFromStore } from "./platform-storage.js";
import { upsertEmailUserInState, type AuthCodeRecord, type AuthSessionRecord, type PlatformUser } from "./platform.js";

export interface AuthUser {
  userId: string;
  email: string;
  displayName: string;
}

export interface RequestEmailCodeResult {
  ok: true;
  devCode?: string;
}

const CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = "agentball_session";

export async function requestEmailCode(emailInput: string): Promise<RequestEmailCodeResult> {
  const email = normalizeEmail(emailInput);
  const code = randomInt(100000, 999999).toString();
  const now = new Date();
  const record: AuthCodeRecord = {
    email,
    emailHash: hashValue(email),
    codeHash: signCode(email, code),
    attempts: 0,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + CODE_TTL_MS).toISOString(),
  };
  await mutatePlatformState((state) => {
    state.authCodes = (state.authCodes ?? []).filter((item) => item.emailHash !== record.emailHash);
    state.authCodes.unshift(record);
    state.authCodes = state.authCodes.slice(0, 500);
  });
  await sendLoginCode(email, code);
  return isProductionRuntime() ? { ok: true } : { ok: true, devCode: code };
}

export async function verifyEmailCode(emailInput: string, codeInput: string): Promise<{ user: AuthUser; cookie: string }> {
  const email = normalizeEmail(emailInput);
  const code = cleanCode(codeInput);
  const now = new Date();
  const sessionToken = randomBytes(32).toString("base64url");
  const sessionId = hashValue(sessionToken);
  let authUser: AuthUser | null = null;

  await mutatePlatformState((state) => {
    const codes = state.authCodes ?? [];
    const record = codes.find((item) => item.emailHash === hashValue(email));
    if (!record || Date.parse(record.expiresAt) <= now.getTime()) throw new Error("验证码已过期，请重新获取");
    if (record.attempts >= 5) throw new Error("验证码尝试次数过多，请重新获取");
    record.attempts += 1;
    if (record.codeHash !== signCode(email, code)) throw new Error("验证码不正确");

    state.authCodes = codes.filter((item) => item.emailHash !== record.emailHash);
    const user = upsertEmailUserInState(state, email, now.toISOString());
    const session: AuthSessionRecord = {
      sessionId,
      userId: user.userId,
      email,
      emailHash: hashValue(email),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    };
    state.authSessions = [session, ...(state.authSessions ?? [])].slice(0, 2000);
    authUser = publicAuthUser(user, email);
  });

  if (!authUser) throw new Error("登录失败");
  return {
    user: authUser,
    cookie: makeSessionCookie(sessionToken, SESSION_TTL_MS),
  };
}

export async function currentUserFromCookie(cookieHeader: string | undefined): Promise<AuthUser | null> {
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  if (!token) return null;
  const sessionId = hashValue(token);
  const state = await readPlatformStateFromStore();
  const session = (state.authSessions ?? []).find((item) => item.sessionId === sessionId);
  if (!session || Date.parse(session.expiresAt) <= Date.now()) return null;
  const user = state.users.find((item) => item.userId === session.userId);
  if (!user) return null;
  return publicAuthUser(user, session.email);
}

export async function logoutSession(cookieHeader: string | undefined): Promise<string> {
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  if (token) {
    const sessionId = hashValue(token);
    await mutatePlatformState((state) => {
      state.authSessions = (state.authSessions ?? []).filter((item) => item.sessionId !== sessionId);
    });
  }
  return makeSessionCookie("", 0);
}

export function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) {
    throw new Error("请输入有效邮箱");
  }
  return email;
}

function cleanCode(value: string): string {
  const code = value.trim();
  if (!/^\d{6}$/.test(code)) throw new Error("验证码必须是 6 位数字");
  return code;
}

function publicAuthUser(user: PlatformUser, email: string): AuthUser {
  return {
    userId: user.userId,
    email,
    displayName: user.displayName,
  };
}

function signCode(email: string, code: string): string {
  return createHmac("sha256", authSecret()).update(`${email}:${code}`).digest("hex");
}

function hashValue(value: string): string {
  return createHmac("sha256", authSecret()).update(value).digest("hex");
}

function authSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret && isProductionRuntime()) throw new Error("生产环境缺少 AUTH_SECRET");
  return secret ?? "agentball-local-dev-secret";
}

async function sendLoginCode(email: string, code: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.AUTH_EMAIL_FROM;
  if (!apiKey || !from) {
    if (isProductionRuntime()) throw new Error("生产环境缺少邮件发送配置：RESEND_API_KEY/AUTH_EMAIL_FROM");
    return;
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: email,
      subject: "球球智能体登录验证码",
      text: `你的登录验证码是：${code}。10 分钟内有效。`,
    }),
  });
  if (!response.ok) {
    const payload = await response.text().catch(() => "");
    throw new Error(`邮件发送失败：${payload || response.statusText}`);
  }
}

function makeSessionCookie(token: string, maxAgeMs: number): string {
  const secure = isProductionRuntime() ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  return header
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function isProductionRuntime(): boolean {
  return process.env.VERCEL === "1" || process.env.NODE_ENV === "production";
}
