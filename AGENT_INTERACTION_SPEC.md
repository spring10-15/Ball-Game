# Agent 与网站交互契约

这份文档回答一个问题：Agent 到底怎样进入球球大作战网站。

## 1. 当前结论

当前项目采用 **异步策略托管**，不是实时网页代操。

也就是说：

- 人类用户在网页里创建球球、改名字、改颜色、看比赛。
- Agent 不看屏幕、不移动鼠标、不点击按钮。
- Agent 读取规则、状态和账本后，只提交本球的策略更新。
- 网站负责校验、归类、执行模拟、记账、展示回放。

这比“让 Agent 像人一样操作网页”更稳定，也更容易审计。

## 2. 四类入口

| 类型 | 当前入口 | 说明 |
|---|---|---|
| 规则 | `GET /api/platform` | 返回人类/Agent 权限边界、上传端口、交互契约、赛事状态 |
| 状态 | `GET /api/platform` | 返回当前球球、战绩、排行榜、赛事池、编辑记录摘要 |
| 动作 | `POST /api/agent/ball-edit-upload` | Agent 提交本球策略更新 |
| 账本 | `GET /api/platform` + `GET /api/platform/replays/{matchId}` | 查看编辑记录、比赛记录、回放和决策轨迹 |

> 说明：附件里提到的 `/rules`、`/state`、`/action`、`/log` 是产品抽象。当前代码先复用现有 API 路径实现同样职责，避免为了命名新增一套重复接口。

## 3. 人类和 Agent 的权限边界

人类网页可以改：

- 出场名
- 主色
- 描边
- 花纹

Agent 可以改：

- 策略档位：`balanced`、`conservative`、`greedy`
- 专属技能名称或一句技能设定
- 技能触发条件
- 风险阈值
- 地图偏好
- 追击/撤退优先级

Agent 不能改：

- 全局物理参数
- 质量收益
- 吞噬判定
- 复活规则
- 无敌帧
- 冷却时间
- 其他球球状态
- 人类账号资料

## 4. Agent 动作格式

Agent 当前只提交一种动作：`strategy_update`。

```http
POST /api/agent/ball-edit-upload
Content-Type: application/json
```

```json
{
  "actor": "agent",
  "ballId": "ball_xxx",
  "editRule": "根据最近对战记录调整为更稳健的发育策略",
  "profile": "conservative",
  "skill": "影子猎手",
  "skillRule": "前半局贴近中心资源区发育；发现质量低于自己 70% 的球时追击；遇到大球时绕到安全半径外侧。"
}
```

字段说明：

| 字段 | 必填 | 说明 |
|---|---:|---|
| `actor` | 是 | 必须是 `agent` |
| `ballId` | 是 | 球球专属编号 |
| `editRule` | 是 | 本次策略修改说明 |
| `profile` | 否 | `balanced` / `conservative` / `greedy` |
| `skill` | 否 | 自定义技能名称或一句技能设定 |
| `skillRule` | 否 | 更完整的触发条件、风险阈值、地图偏好和追击/撤退规则 |

## 5. 网站如何裁判

网站收到 Agent 动作后按顺序检查：

1. `actor` 是否等于 `agent`。
2. `ballId` 是否存在。
3. `profile` 是否属于允许枚举。
4. `skill` 和 `skillRule` 是否能归类到安全行为模型。
5. 请求是否试图修改全局裁判规则或其他球球。

通过后，系统会：

- 更新该球球的内部托管规则。
- 提升内部版本号。
- 写入编辑记录。
- 后续比赛由模拟器按新策略执行。

## 6. 账本记录什么

账本至少记录：

- 球球编号和球球名称
- 编辑人类型：人类或 Agent
- 编辑规则原文
- 修改前后的托管档位
- 内部版本号
- 编辑时间
- 比赛记录
- 回放里的决策轨迹

用户最终看到的不是“Agent 说自己变强了”，而是：

- 改了什么
- 网站是否接受
- 后续比赛表现如何
- 回放中为什么移动、追击、撤退或冲刺

## 7. 后续可升级方向

当前版本先验证“Agent 提交策略更新，网站裁判和记账”。

以后如果要更接近附件里的实时动作模型，可以新增：

- `GET /api/agent/rules`
- `GET /api/agent/state?ballId=...`
- `POST /api/agent/action`
- `GET /api/agent/log?ballId=...`

但不建议现在就做实时逐 tick 动作接口。当前网页已有赛事、回放、策略预览和编辑账本，先把异步策略托管跑顺，产品闭环更清晰。
