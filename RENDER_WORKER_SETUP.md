# Render 赛事 Worker 部署说明

这个 Worker 负责在线上持续执行：

```bash
npm run event-worker
```

它会每分钟调用 Vercel 生产环境里的赛事接口：

- 有进行中的 24 小时赛事
- 参赛球球数量至少 2 个
- 每 60 秒自动跑一局
- 每局结果和完整回放由 Vercel API 写回 Redis/KV

## Render Blueprint

仓库根目录已经添加 `render.yaml`，服务名：

```text
agentball-event-worker
```

Render 会按这个配置创建一个 Background Worker。

配置里明确使用：

```yaml
plan: starter
```

原因是 Render 的 Background Worker 不支持免费实例，持续跑 24 小时赛事需要常驻实例。

## 必填环境变量

在 Render 创建 Blueprint 时填这个变量，值要和 Vercel Production 里的 `CRON_SECRET` 保持一致：

```bash
CRON_SECRET=...
```

不要把这个值写进 GitHub。

## 创建步骤

1. 打开 Render Dashboard。
2. New -> Blueprint。
3. 连接 GitHub 仓库：

```text
spring10-15/Ball-Game
```

4. Render 会识别根目录的 `render.yaml`。
5. 在环境变量页面填入 `CRON_SECRET`。
6. 创建后观察 Logs，看到类似下面日志即为运行成功：

```text
[event-worker] started. round=60s idle=10s
[event-worker] round 1 platform_xxx winner=... participants=2
```

## 注意

Render Worker 是持续运行服务，会产生实例运行费用。不要同时启动多个同样连接 `agentball:platform-state` 的 Worker，否则赛事会被多个进程重复推进。
