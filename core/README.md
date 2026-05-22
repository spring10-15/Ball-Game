# core/ —— 模拟引擎与策略示例

这是 v0 的最小可运行骨架。能让你在本地 Node 环境里跑通一局对战、看到 replay
和事件流，是后续 SDK / 后端 API / 网页观看器全部产物的基础。

## 文件清单

| 文件 | 作用 |
|---|---|
| `types.ts` | 全部对外类型定义（策略、视图、replay、事件、配置） |
| `simulator.ts` | tick 模拟引擎：物理、吞噬、burst、复活、视野裁剪 |
| `starter-conservative.ts` | 保守型 starter 策略 |
| `starter-greedy.ts` | 贪婪型对照策略 |
| `starter-balanced.ts` | 均衡型候选策略，用于和 starter 对照迭代 |
| `run-sim.ts` | 本地 runner，跑一局并输出 replay |
| `evaluate.ts` | 多局评测 runner，跨 seed 聚合胜率、排名、分数和稳定性指标 |

## 快速开始

```bash
# 在项目根目录（不是 core/ 里面）
npm init -y
npm i -D typescript tsx @types/node
npx tsx core/run-sim.ts
```

跑完后你会在 `out/` 看到三个 JSON：

- `last-replay.json` —— 完整 replay（frames + events + results）
- `last-events.json` —— 仅事件流，给 coding agent 复盘最快
- `last-metrics.json` —— 每个 agent 的聚合指标

多局评测：

```bash
npm run eval -- --matches 100 --duration 60
```

跑完后会在 `out/eval-summary.json` 写入每局名次和聚合摘要。策略迭代时优先看：

- `avgRank`：是否真正转化成名次优势。
- `avgScore` / `avgFinalMass`：是否稳定长体积。
- `avgDeaths` / `avgDangerSeconds`：风险是否变高。
- `burstEfficiency`：burst 是否产生击杀或脱险效果。
- `decisionErrors`：策略是否出现无效动作、超时或异常。

本地可视化训练台：

```bash
npm run dev -- --host 127.0.0.1
```

打开 `http://127.0.0.1:5173/` 后可以直接看 replay、事件复盘和训练评测。
在 dev server 下，页面里的 `Run sim` / `Run eval` 按钮会调用本地 API 重新生成
`out/last-replay.json` 和 `out/eval-summary.json`；静态 build 不包含这些写文件 API。

## tsconfig.json 推荐

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["core/**/*"]
}
```

## 当前局限（v0 已知）

- 策略代码直接当 JS 函数调用，**没有真沙盒隔离**。生产前必须接 isolated-vm。
- CPU 超时不会强制中断，只在 wall-clock > 3ms 时降级为 idle + 记 event。
- Replay 是 JSON，未压缩。
- 没有接入 ELO（在排程器层计算，本地 runner 仅产出 score）。
- 排名平分时不会用历史均值排序。
- 没有 SDK 包装，策略直接 `import` 类型。

## 下一步建议

1. 把 `run-sim.ts` 输出的 `last-events.json` 喂给一个 coding agent，
   让它独立读一遍、写一份"保守型为什么输 / 贪婪型为什么死得快"的分析。
2. 让 coding agent 在 `starter-balanced.ts` 或 `starter-conservative.ts` 基础上提出**一个**改动
   （比如调 burst 触发阈值），用 `npm run eval -- --matches 100 --duration 60`
   对比胜率、平均名次、平均综合分和死亡次数。
3. 当上面两步能跑通，意味着"agent 训练循环"在最简陋的形式下成立，
   下一步就可以补 isolated-vm、后端 API、网页 replay 播放器。
