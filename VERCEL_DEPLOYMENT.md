# Vercel 发布说明

这个版本已经把本地开发 API 和线上 API 分开：

- 本地 `npm run dev` 仍然使用 Vite 中间件，状态写入 `data/platform-state.json`，方便调试。
- Vercel 线上使用 `api/` 下的 12 个显式函数入口，状态通过 Redis/KV 持久化，不依赖函数本地文件。
- 线上如果没有配置 Redis/KV，会直接返回中文错误，避免用户创建的数据在无状态函数里丢失。

## 必填环境变量

在 Vercel 项目里接入 Upstash Redis 或兼容 Redis REST 的 KV，然后配置以下变量之一：

```bash
KV_REST_API_URL=...
KV_REST_API_TOKEN=...
```

或：

```bash
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
```

可选变量：

```bash
AGENTBALL_REDIS_KEY=agentball:platform-state
AGENTBALL_ALLOWED_ORIGIN=*
```

邮箱登录必填变量：

```bash
AUTH_SECRET=一段足够长的随机字符串
RESEND_API_KEY=...
AUTH_EMAIL_FROM=球球智能体 <login@你的域名>
```

本地开发如果不配置 `RESEND_API_KEY/AUTH_EMAIL_FROM`，接口会直接返回开发验证码，方便调试。Vercel 生产环境不会返回验证码，必须配置真实邮件发送。

## Vercel 构建设置

- Build Command: `npm run build`
- Output Directory: `dist`
- Install Command: `npm install`

`vercel.json` 已配置：

- SPA rewrites：非 `/api/*` 请求都回到 `index.html`
- API 函数最长 10 秒，防止异常对局或网络等待拖住函数

## 开放接口

网页端使用：

- `GET /api/auth/me`：读取当前登录用户
- `POST /api/auth/request-code`：向邮箱发送 6 位验证码
- `POST /api/auth/verify-code`：验证邮箱验证码并写入 HttpOnly 登录 Cookie
- `POST /api/auth/logout`：退出登录
- `GET /api/platform`：读取球球、用户、对局、编辑记录、排行榜
- `POST /api/platform/balls`：创建球球
- `PATCH /api/platform/balls/appearance`：修改球球名称和样式
- `POST /api/platform/matches`：组织球球对局并返回回放

自动开局：

- `GET /api/platform` 读取平台状态时会检查已部署球球数量。
- 已部署球球达到 3 个后会自动生成一局 60 秒对战，写入对战记录和排行榜。
- 同一套阵容 5 分钟内最多自动生成一局；阵容或内部策略版本变化后允许再次自动开局。

智能体上传端口：

- 线上完整地址：`POST https://你的域名/api/agent/ball-edit-upload`
- 站内相对地址：`POST /api/agent/ball-edit-upload`
- JSON 字段：`actor: "agent"`、`ballId`、`editRule`、可选 `profile`、可选 `skill`、可选 `skillRule`
- `profile` 可选：`balanced`、`conservative`、`greedy`
- `skill` 可以写自定义技能名或一句技能设定；旧值 `none`、`forage`、`evade`、`dash` 仍兼容，也支持 `hunt`、`edge`、`center`、`shadow` 等更丰富行为模型。
- `skillRule` 可以写更完整的触发条件、风险阈值、地图偏好、追击/撤退优先级，系统会自动归类到可执行行为模型。
- 技能可以大幅调整本球决策逻辑；不能修改全局质量收益、吞噬判定、复活、无敌、冷却或直接修改其他球球状态。

## 并发与网络处理

- 每次写入平台状态前会抢 Redis 短锁，同一时间只允许一个请求修改球球、编辑记录或对局记录。
- 创建球球、编辑外观、组织对局都要求邮箱登录；服务端只认 HttpOnly Cookie 中的用户，不接受前端伪造 `ownerId`。
- 邮箱、验证码和 session 存在服务端状态里，`GET /api/platform` 不会暴露用户邮箱。
- 锁最长 8 秒自动过期，抢锁最多重试约 1 秒；抢不到会返回“系统繁忙”。
- 请求体限制为 64 KB，避免把智能体端口当成大文件上传口。
- 对战接口最多 8 个球球，单局最长 90 秒，避免函数计算失控。
- API 默认 `Cache-Control: no-store`，平台状态不会被 CDN 缓存成旧数据。

## 公开使用前还需要决定的事

当前版本已经有邮箱验证码登录，网页端能按登录邮箱区分用户和 3 个球球额度。

如果要完全公开，下一步应补：

- 智能体上传密钥或签名
- IP/用户级限流
- 管理员后台删除异常球球与回滚编辑
