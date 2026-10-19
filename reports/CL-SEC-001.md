# CL-SEC-001 安全修复验收

日期：2026-10-19（Asia/Singapore）。实际仓库：`C:\Git\CharacterLife\CharacterLife`。

## 安全基线与数据保护

- 仓库已有 Git；起始 HEAD 为 `4c916e0`。任务开始时存在未提交的 OneBot 实现、配置及文档改动，未覆盖或纳入本任务提交。
- 独立备份：`C:\Git\CharacterLife-backups\CL-SEC-001-20261019`。包含完整 Git bundle、原始已修改文件的二进制补丁、Git 状态以及工作区副本（包括未追踪文件和本地数据，排除 `.git`、依赖及缓存）。备份目录已关闭继承权限并授权当前用户；Git bundle 已验证可读取且包含完整历史。
- 基线运行环境：Windows、Node v26.7.0、npm 10.8.1。未安装新依赖。
- 基线 `npm run typecheck`：退出码 0。基线 `npm test`：181 通过、0 失败、0 跳过，耗时约 9.41 秒。没有既有测试失败计入修复成果。
- 起始仓库追踪了 12 个生成日志和 3 个实验 JSON 报告；其中可能包含对话输出。安全整理提交 `64da581` 停止追踪这些文件，磁盘原件及独立备份保留。没有删除 SQLite 或真实用户数据。
- 当前追踪文件中未发现 `.env`、SQLite、日志、常见私钥文件；对追踪文件内容做了常见密钥模式扫描，无匹配。此检查不能证明所有自由文本均无隐私，原有生成对话报告已按保守策略移出索引。
- `.gitignore` 增补日志、SQLite 及其 sidecar、JSONL、生成 JSON 报告、备份、补丁、常见密钥文件与 `secrets/`。`.env.example` 继续作为配置模板追踪。
- 历史提交仍包含旧日志和生成报告，本任务没有改写历史或推送远端。对外分享前需单独审查历史；若发现真实密钥，必须撤销并轮换，移出当前索引不能撤销已泄露凭据。

## 根因与修复

旧实现先检查共享 Token，再信任 Header 或请求体中的已绑定用户标识。绑定只证明身份与实例有关联，不能证明请求方拥有该身份。因此，A 拥有共享 Token 时可以选择已绑定的 B，继而读取 B 的状态、记忆或执行身份管理操作。

现在 `createApiServer` 在启动时建立凭据到 `sillytavern` 平台身份的固定映射，并保存映射副本。请求必须先通过 Bearer 凭据认证；后续所有实例访问、消息、会话和绑定操作均使用该认证主体。

- 原有 `token` 配置仅授权 `stIdentityUserId`（默认 `local-default`），本地单用户客户端无需增加身份 Header。
- 新增 `credentials: [{ token, platformUserId }]`，支持受信任本机客户端的身份隔离。与 `token` 互斥；空列表、重复 Token、短 Token、空身份或前后空白配置拒绝启动。
- Header 与请求体 `identity` 分别检查，任一不符均返回 403 `IDENTITY_MISMATCH`。不会因另一个字段匹配而放行，也不会根据身份是否已绑定改变鉴权结论。
- 缺少或错误凭据返回 401。比较固定长度 SHA-256 摘要时使用常量时间比较；按完整凭据摘要进行 API 限流。
- 500 内部异常与 502 无回复错误返回固定信息，不回传内部异常、数据库错误或 Gateway reason。启动脚本不再打印真实 Token。
- 审查了 `IdentityService`：它是进程内部的身份与实例注册服务，本身不认证凭据；增加英文注释明确入口必须先认证。现有一次性绑定码、拒绝静默改绑和实例关联行为保持不变。
- 未修改角色人格、记忆策略、状态裁决规则或数据库结构。

## 回归验证

新增 `tests/adapters/api-auth.test.ts`，通过真实 HTTP 和临时 SQLite 测试，使用离线 Mock Provider，不访问真实平台或真实用户数据库。

| 场景 | 结果 |
|---|---|
| A 凭据访问 A 状态、记忆、会话和消息 | 成功 |
| A、B 均已绑定，A 通过 Header 冒用 B | 403 |
| A 无伪造 Header，直接访问 B 实例或记忆 | 403；删除非本人记忆返回 404 |
| 请求体冒用 B，或 Header=A、请求体=B | 403，写操作无副作用 |
| 伪造身份调用消息、OpenAI 消息、会话、签码、兑换、解绑、删除记忆 | 拒绝，B 绑定和记忆保持，B 绑定码未被消费 |
| 缺失、空或错误 Token，附带有效 B 身份 | 401 |
| B 凭据省略 Header | 正确解析为 B，不回退到 A 或 local-default |
| 未知身份、local-default 回退、非字符串身份字段 | 拒绝 |
| 服务启动后修改传入的凭据列表 | 已认证范围不变 |
| 新身份凭据兑换合法 QQ 绑定码，无预先绑定 | 成功 |
| 原有 QQ→酒馆记忆连续性、重启与一次性绑定码 | 通过 |
| 内部异常含模拟 SQL、私有路径和密钥；Gateway reason 含同类信息 | 响应不含这些信息 |

修复前执行新增测试，7 项中 6 项失败，其中越权读取与写入得到 200 而非预期 403，内部异常泄漏测试也失败；完整输出保留于备份目录的 `auth-red.log`。随后补充边界用例，最终新增 8 项全部通过。

在实际仓库目录执行：

```cmd
npm run typecheck
npm test
node --test --test-isolation=none tests/adapters/api-auth.test.ts tests/adapters/sillytavern.test.ts tests/cross-platform/continuity.test.ts tests/cross-platform/binding-codes.test.ts
```

最终结果：typecheck 退出码 0；完整测试 189 通过、0 失败、0 跳过，耗时约 10.14 秒；定向测试 28 项通过。基线和最终完整日志位于独立备份目录的 `baseline-*.log` 与 `final-*.log`。

保留原有测试用例，仅将两处依赖旧身份选择行为的断言从 400 / `IDENTITY_NOT_BOUND` 更新为 403 / `IDENTITY_MISMATCH`。没有跳过或删除测试。任务文件的 `git diff --check` 通过；全工作区另有任务开始前已存在的 `reports/V02_TEST_REPORT.md` 末尾空行提示，未修改。

## 修改文件

功能及验收提交涉及：

- `.gitignore`
- `src/api/server.ts`
- `src/identity/identity-service.ts`（仅明确内部信任边界的注释）
- `examples/sillytavern/start-server.ts`
- `tests/adapters/api-auth.test.ts`（新增）
- `tests/adapters/sillytavern.test.ts`
- `tests/cross-platform/continuity.test.ts`
- `docs/SILLYTAVERN_SETUP.md`
- `docs/openapi.yaml`
- `reports/CL-SEC-001.md`（本文）

安全整理提交另外停止追踪以下生成文件，原文件仍在磁盘：

- `reports/ab-results.json`、`reports/persona-continuity.json`、`reports/real-model-run.json`
- `reports/logs/` 下的 `ab-run.log`、`persistent-demo-compress.log`、`persistent-demo.log`、`persona-continuity.log`、`qq-demo.log`、`st-demo.log`、`st-real-probe.log`、`test-run-v02.log`、`test-run.log`、`three-day-demo.log`、`typecheck-v02.log`、`typecheck.log`

## 迁移、部署与剩余风险

1. 单用户保持原启动方式。若 Token 曾共享，必须轮换；同一 Token 的持有人始终代表同一主体，无法相互区分。
2. 旧的“共享 Token + 用户 Header”用法停止支持。管理员需在可信环境核实原身份归属，为原 `platformUserId` 配置独立随机 Token，再交付给对应客户端。推荐 32 字节随机值；数据库及原身份绑定无需迁移或清除。
3. 绑定码只授权关联实例，不提供登录认证。检查修复前可能被冒用创建的绑定，等待旧绑定码过期后恢复使用；不要自动删除绑定或用户记忆。已绑定到其他实例的身份仍需显式解绑后改绑。
4. 当前安全支持回环监听、受信任本机进程；多个身份应使用独立凭据。内置环境变量启动器保持单用户，多凭据需使用文档中的服务端装配方式。
5. 不支持直接公网或不受信任多租户部署。没有原生 TLS、自动到期或会话撤销、认证失败全局限流、跨凭据全局绑定码猜测防护及实例配额。配置轮换或撤销需重启。8 位 Token 下限仅为兼容旧本地配置，不足以替代高熵密钥。
6. 凭据失窃仍可冒用其对应主体；同一 OS 账户读取配置、数据库或进程内存可绕过 HTTP 边界。QQ / OneBot 网关必须自身可信并验证其传输凭据，本任务没有扩展这些传输的认证保证。
7. 本次没有自动修复历史上可能被冒用产生的绑定，也没有进行真实平台联调或公网渗透测试。

## 提交与回滚

原始基线 `4c916e0`；安全整理提交 `64da581`；功能修复提交标题为 `fix(security): bind API credentials to authenticated identities (CL-SEC-001)`，提交哈希随交付回复提供。两次提交均仅保存在本地。

先保存其他未提交工作，再对该功能修复提交执行 `git revert <修复提交哈希>` 即可回滚代码、测试和文档；这不会删除 SQLite 或恢复旧的共享 Token 配置。回滚将重新引入已知越权漏洞，仅应在隔离本机、停止外部访问的状态下进行。

建议保留安全整理提交。若要连同原始工作区恢复，独立备份中的 `baseline.bundle` 可在新目录克隆原历史，`workspace/` 可恢复当时未提交文件和本地数据，`preexisting.patch` / `preexisting-status.txt` 可用于核对。停止服务后操作备份；避免用硬重置或清理未追踪文件处理现有数据。
