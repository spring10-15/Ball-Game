# 球球大作战 UAT 上线配置

这份文档给 Vercel 上线时照着操作。核心原则只有一句：

**Vercel 线上不能用本地文件保存用户数据，必须配置 Redis/KV。**

## 为什么必须配置 Redis/KV

本地开发时，用户、球球、登录验证码、对战记录会写到：

```text
data/platform-state.json
```

但是 Vercel 的函数是无状态的，线上不能依赖这个本地文件。否则用户创建的球球、登录状态、对战记录可能在函数重启或换节点后丢失。

当前代码已经处理好了：

- 本地开发：自动用 `data/platform-state.json`
- Vercel 线上：自动要求 Redis/KV
- 如果线上没有 Redis/KV：接口会返回中文错误，提醒先配置持久化

## UAT 必须配置的东西

### 1. Redis/KV

用途：保存用户、球球、验证码、登录 session、对战记录、编辑记录。

推荐在 Vercel 项目里接 Upstash Redis Marketplace。接入后，Vercel 会生成类似下面的变量。

两组选一组即可：

```bash
KV_REST_API_URL=...
KV_REST_API_TOKEN=...
```

或：

```bash
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
```

如果 Marketplace 自动生成的是 Upstash 变量名，不需要手动改代码，项目已经兼容。

### 2. 登录密钥

用途：给邮箱登录 session 做签名。

变量名：

```bash
AUTH_SECRET=一段足够长的随机字符串
```

可以在本机生成：

```bash
openssl rand -base64 32
```

把输出复制到 Vercel 的 `AUTH_SECRET`。

### 3. 邮件发送

用途：给用户邮箱发送 6 位登录验证码。

变量名：

```bash
RESEND_API_KEY=...
AUTH_EMAIL_FROM=球球智能体 <login@你的域名>
```

推荐在 Vercel Marketplace 接 Resend。Resend 集成通常会自动写入 `RESEND_API_KEY`。

`AUTH_EMAIL_FROM` 需要用你在 Resend 里验证过的发件域名或发件地址。没有真实邮件发送配置时，Vercel 线上不会把开发验证码直接显示给用户。

## Vercel 页面操作顺序

1. 打开 Vercel Dashboard。
2. Import Git Repository，选择：

```text
spring10-15/Ball-Game
```

3. 构建配置使用默认即可；如果需要手填：

```text
Framework Preset: Vite
Build Command: npm run build
Output Directory: dist
Install Command: npm install
```

4. 进入项目的 Storage / Marketplace，添加 Upstash Redis。
5. 确认环境变量里已经有 Redis/KV 变量。
6. 进入项目 Settings -> Environment Variables，补齐：

```bash
AUTH_SECRET=...
RESEND_API_KEY=...
AUTH_EMAIL_FROM=...
AGENTBALL_ALLOWED_ORIGIN=*
AGENTBALL_REDIS_KEY=agentball:platform-state
```

7. 重新部署一次。环境变量只会对新的部署生效。

## UAT 验收清单

部署完成后，按这个顺序测：

1. 打开 Vercel 域名。
2. 输入邮箱，能收到验证码。
3. 登录后能看到首页。
4. 创建 1 个球球，刷新页面后球球仍然存在。
5. 修改球球样式，刷新页面后样式仍然存在。
6. 规则编辑里点击“复制给智能体”，能复制内容。
7. 删除球球，刷新页面后不会恢复。
8. 换另一个邮箱登录，只能看到自己的球球。

第 4、5、7 步能通过，就说明 Redis/KV 已经生效。

## 常见问题

### 登录后刷新，球球没了

Redis/KV 没配好，或环境变量没有应用到当前部署。检查变量后重新部署。

### 获取验证码失败

检查：

- `RESEND_API_KEY`
- `AUTH_EMAIL_FROM`
- Resend 发件域名是否已验证

### 接口提示生产环境未配置持久化存储

说明 Vercel 当前部署没有读到 Redis/KV 环境变量。检查变量名是否是以下之一：

```bash
KV_REST_API_URL
KV_REST_API_TOKEN
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
```

### 修改了环境变量但没变化

重新部署。Vercel 的环境变量变更不会自动作用到旧部署。
