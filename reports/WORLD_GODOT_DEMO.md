# 真实 DeepSeek × Godot 图形演示记录（V0.3.1）

> 环境：Windows / Node v26.7.0 / Godot `4.6.2.stable.official.71f334935`（OpenGL 3.3，RTX 3070 Ti Laptop）
> CharacterLife：`fix/f5-personality-and-world-relevance`
> CharacterLife-World：`feature/cl-backend-adapter` @ `63ef1f5`
> 日期：2026-10-20
>
> **token 未出现在本文档、命令输出或日志里。** 运行时只从环境变量读取，控制台只回显掩码。

## 1. 结论

| 验收项 | 结果 |
|---|---|
| 用户自然语言请求触发一次真实 Godot 动作 | ✅ 真实 DeepSeek 产出候选 → 准入 → Godot 领取并执行 11 步寻路 + 桌面交互 |
| 下一轮对话正确引用已确认的执行结果 | ✅ `wa_001 succeeded (world time 17651)` → 下一轮回复"看过了" |
| 无关请求不触发桌子动作 | ✅ `admitted: []`（3 次不同措辞） |
| 世界离线不谎报 | ✅ 离线时 `wa_001` 保持 `pending`，回复"还没到。我打算过去看看…" |
| 旧 QQ / OneBot / SillyTavern 无回归 | ✅ `npm test` 301 passed / 0 failed（含 4 个适配器测试文件） |

## 2. 配置（本机）

```bat
:: 终端 A —— CharacterLife（真实模型 + 独立测试库）
set "DEEPSEEK_API_KEY=<从本地文件读入，不落盘到仓库>"
set "CLWORLD_PORT=8787"
set "CLWORLD_WORLD_IDS=cl-world-main"
set "CLWORLD_DEV_AUTOSEED=false"
set "CLWORLD_TOKEN=<世界 token>"
set "CHARACTERLIFE_API_TOKEN=<聊天 token>"
set "CHARACTERLIFE_DB=examples/.data/world-godot-real.db"
npm run world:dev
```

```bat
:: 终端 B —— Godot（真实图形窗口）
cd /d C:\Git\CharacterLife\CharacterLife-World
set "CLWORLD_TOKEN=<与世界 token 相同>"
set "APPDATA=C:\Git\CharacterLife\.runtime\appdata"
run.cmd -- --cl-backend
```

> `APPDATA` 重定向是沙箱需要：Godot 默认把 `user://logs` 写到 `%APPDATA%\Godot\...`，
> 当前环境的文件沙箱不允许写仓库外路径，不重定向会 `Failed to open user://logs/...` 并崩溃。

```bat
:: 终端 C —— 发一句自然语言（可重复）
set "CHARACTERLIFE_API_TOKEN=<聊天 token>"
npm run world:say -- "你能帮我去桌子旁看看吗？"
```

`world:say` 每次带唯一 `x-request-id`：不带的话服务端用「身份 + 轮数 + 原文」哈希做消息 id，
同一句话发第二次会被判成重复消息（HTTP 502 `NO_REPLY`）。

## 3. 正常执行

**T1**（真实模型）：

```
POST http://127.0.0.1:8787/v1/messages  →  HTTP 200  (1609ms)
用户：你能帮我去桌子旁看看吗？
Provider：deepseek / deepseek-flash
回复：行，我去看看。刚才那本旧书还翻开着，我顺手确认一下有没有被压出新的折痕。
世界动作：{ "admitted": [ { "actionId": "wa_001", "verb": "use", "target": "desk_01",
              "status": "pending", "narration": "intent" } ], "rejected": [] }
```

**Godot 侧真实执行**（JSONL，`cl_backend_started` 之后）：

```
cl_action_received   wa_001   localActionId=cl:<进程标识>:wa_001
path_planned         cells=[[1,1],[2,1],[2,2],[2,3],[2,4],[2,5],[3,5],[4,5],[4,4],[4,3],[4,2],[5,2]] steps=11
actor_step × 11
interaction_started  verb=toggle
desk_state_changed   interaction_count=1 is_active=true
action_status        completed
cl_action_result     result=succeeded atWorldTimeMs=4291
cl_event_delivered   duplicate=false
```

**T2**（同一进程下一轮）：

```
用户：刚才桌边那件事怎么样了？
Provider：deepseek / deepseek-flash
回复：看过了。桌上是一本翻开的旧书、一块镇纸，还有一支铅笔。书页没被压出新的折痕…
世界动作：{ "admitted": [], "rejected": [] }
世界上下文 confirmed: wa_001 use(desk_01) succeeded atWorldTimeMs=17651 narration=done
          unconfirmed: []
```

## 4. 无关聊天不触发

```
用户：今天天气不错，你在忙什么？          → admitted: []   （模型回复为空，触发既有降级台词）
用户：最近工作累不累？                    → admitted: []
用户：你工作室今天安静吗？                → admitted: []
```

三轮都没有登记世界动作；`worldActions.admitted` 恒为空数组。

## 5. 世界离线不谎报

关闭 Godot，再在同一实例上继续：

```
O1  用户：你能去桌子旁看看吗？
    回复：可以。我去看看。                       ← 将来时，无完成声明
    世界动作：admitted wa_001 status=pending narration=intent

O2  用户：你到桌边了吗？那边怎么样？
    回复：还没到。我打算过去看看，桌上的东西上回看是翻开的旧书、镇纸和铅笔，
          这回有没有变，得走近了才知道。          ← 明确说"还没到"
    世界上下文 confirmed: []   unconfirmed: [wa_001 pending]

O3  重新启动 Godot 后
    cl_action_received wa_001 → path_planned 11 steps → completed → cl_event_delivered
    用户：现在到桌边了吗？
    回复：到了。桌上还是那本翻开的旧书…            ← 此时才有 confirmed 依据
    世界上下文 confirmed: wa_001 succeeded atWorldTimeMs=4291
```

## 6. 观测字段（证明动作来自模型）

`/v1/messages` 响应新增（附加字段，不改旧字段语义）：

```json
{
  "provider": "deepseek",
  "model": "deepseek-flash",
  "worldActions": { "admitted": [ { "actionId": "wa_001", "status": "pending", "narration": "intent" } ], "rejected": [] },
  "worldContext": { "source": "in-process", "persistent": false, "confirmed": [], "unconfirmed": [ ... ] }
}
```

`world:say` 把同一份数据打印成人读形式，`actionId` 与 Godot 日志里的 `action_id` 一一对应。

## 7. 本轮观察到的真实问题

1. **`deepseek-flash` 在带历史的多轮追问里会返回纯空白**（实测 `19` 个空格，`finish_reason=stop`），
   触发既有的 `EMPTY_REPLY_FALLBACK`。同一句话在没有历史的新会话里能正常回答；
   最小复现见 §8。这与 V0.2 记录过的"51 个空格"是同一类问题，属于模型侧行为，本次未修。
2. **模型会把自己编造的场景细节写进记忆**：T2 里"旧书/镇纸/铅笔"没有世界回执依据，
   但被写进 episodic 记忆，后续轮次作为资料检索回来，于是越说越具体。
   系统块已加规则 5（"回执没说的细节不要编"），能降低但不能根除。
3. **CL 与 Godot 重启后 `actionId` 会重用**：CL 动作队列在内存（`wa_001` 从头开始），
   Godot 的跨重启幂等表也是空的，但同一 Godot 进程内保留旧映射，
   于是重启 CL 后旧进程会把新 `wa_001` 判成重复（`cl_action_duplicate`），动作不执行。
   本次做法是**两边一起重启**。这是两边文档都写明的已知限制。
4. **短问题偶尔得到空回复**（T3 三次）。不影响"不触发动作"的结论，但对话体验差。

## 8. 最小复现（问题 1）

```bash
# 同一 system prompt，仅历史不同
node probe.ts   # no-history  → 231 字符正常回复
                # with-history → 19 个空格
```

历史里 assistant 消息是自然语言正文，而请求 `response_format=json_object`；
模型可能因此认为上一轮格式不合法而放弃输出。若要修，方向是让历史里的 assistant
内容保持 JSON 信封形状（属于 provider/上下文层改动，不在本轮范围）。

## 9. 未做 / 不宣称

- 不宣称跨会话世界记忆：`worldContext.persistent` 恒为 `false`。
- 不在 Godot 侧扩展场景、角色动画、美术资源。
- 不新增 Skill Registry、行为树、多 Agent、第二套数据库。
- 世界动作仍只有 `use(desk_01)`。
