# Pico TODO

这份清单按依赖顺序推进。每个项目都先完成 Design，再完成 Plan、Implement 和 Verify。上一个 gate 没通过时，不进入下一个项目。

## MVP 边界

MVP 包含 native web、daemon、Workspace、Chat、worktree、OMP、RPC 和 frontend state。

MVP 不包含 Discord 实现和永久 purge。`@pico/discord` 在 MVP 后实现。Archive 在 MVP 只保留数据并隐藏 Chat。

## 依赖顺序

```text
00 dependencies and spikes
  -> 01 contract
  -> 02 config
  -> 03 logging
  -> 04 persistence
  -> 05 worktree
  -> 06 omp
  -> 07 application
  -> 08 rpc
  -> 09 frontend-state
  -> 10 daemon
  -> 11 web
  -> 12 MVP verification
  -> 13 discord, post-MVP
```

## Implementation guidance

- [ ] 修改陌生 subsystem 前先运行 `how`。
- [ ] 有争议的架构决定在冻结前运行 `interrogate`。
- [ ] 大阶段使用 `show-me-your-work` 记录 decision trail。
- [ ] TypeScript 代码遵循 `typescript-best-practices`。
- [ ] Web 行为使用 `control-ui` 验证真实页面。
- [ ] Commit 前运行 `/deslop`。
- [ ] Review 前运行 `/no-comments`。
- [ ] 所有文档、PR 描述和 commit message 使用 `unslop` 与 `technical-writing`。
- [ ] 每个 phase 单独验证并保持可独立 review。

## 00. Dependency baseline 和 critical spikes

### Design

- [ ] 固定 `@oh-my-pi/pi-coding-agent@18.0.10`。
- [ ] 固定所有 Effect v4 package 为 `4.0.0-rc.112`。
- [ ] 确认需要的 Effect package 集合。
  - [ ] `effect`
  - [ ] `@effect/atom-react`
  - [ ] `@effect/platform-bun`
  - [ ] `@effect/sql-sqlite-bun`
  - [ ] `@effect/vitest`
- [ ] 确认 MVP 保持 `async.enabled=false`。
- [ ] 确认 session path 使用 `<picoRoot>/sessions/<chatId>.jsonl`。
- [ ] 确认运行中消息使用 steer。

### Plan

- [ ] 列出 manifest、lockfile 和 installed dependency 的差异。
- [ ] 为每个 spike 定义输入、观察值和通过条件。
- [ ] 决定 OMP process-global lifecycle gate 的保留条件。

### Implement

- [ ] 更新 Effect v4 catalog 到 `4.0.0-rc.112`。
- [ ] 安装缺少的 Effect workspace dependency。
- [ ] 更新 lockfile，使 OMP 精确解析到 `18.0.10`。
- [ ] 运行 `bun run vendor:effect`。
- [ ] 阅读匹配版本的 `repos/effect/LLMS.md`。
- [ ] 写最小 OMP session-path spike。
- [ ] 写最小 OMP multi-chat lifecycle spike。
- [ ] 写最小 Effect RPC WebSocket spike。
- [ ] 写最小 Effect Atom stream-reducer spike。

### Verify

- [ ] OMP root session 是 `<chatId>.jsonl`。
- [ ] Artifact root 是相邻的 `<chatId>/`。
- [ ] Subagent output 不增加多余的 `<chatId>/<chatId>/` 层。
- [ ] 两个 headless Chat 可以同时运行。
- [ ] 运行中的 Chat 接受 steer。
- [ ] Dispose 一个 Chat 不破坏另一个运行中的 Chat。
- [ ] 如果 dispose isolation 失败，证明 lifecycle gate 或 shutdown-only disposal 的方案。
- [ ] 一条 WebSocket 可以同时承载 query、command 和 stream。
- [ ] Stream cancellation 会释放服务器订阅。
- [ ] Atom stream 关闭时会取消底层 Effect scope。

## 01. `@pico/contract`

### Design

- [ ] 定义 `Environment`、`Platform`、`Binding`、`Workspace` 和 `Chat` vocabulary。
- [ ] 定义 branded `WorkspaceId`、`ChatId`、`AbsolutePath` 和 timestamp。
- [ ] 定义 regular 和 worktree Workspace union。
- [ ] 定义 `AgentMessage` 和 tool payload 的 pico-owned shape。
- [ ] 定义完整 event 层级。
  - [ ] `AgentEvent`
  - [ ] `WorkspaceEvent`
  - [ ] `ChatEvent`
  - [ ] `DaemonEvent`
  - [ ] `PicoEvent`
- [ ] 定义 `AgentSnapshot` 和客户端 reducer 所需的最小事实。
- [ ] 定义 boundary error。只有调用方需要分支时才增加 tag。
- [ ] 定义 port。
  - [ ] `WorkspaceRepository`
  - [ ] `ChatRepository`
  - [ ] `AgentRuntime`
  - [ ] `WorktreeManager`
  - [ ] `PicoApplication`
  - [ ] `PicoClient`
- [ ] 定义 Effect RPC group、request、result 和 stream Schema。

### Plan

- [ ] 把每个 domain 放进独立 module。
- [ ] 让 Schema 成为 runtime validation 和 TypeScript type 的共同来源。
- [ ] 列出禁止 import 的第三方 package。
- [ ] 设计 exhaustive event reducer test cases。

### Implement

- [ ] 创建 contract package manifest 和 tsconfig。
- [ ] 实现 ID、path、Workspace 和 Chat Schema。
- [ ] 实现 service tag 和 operation signatures。
- [ ] 实现 event unions 和 snapshot Schema。
- [ ] 实现 RPC group。
- [ ] 不创建 barrel `index.ts`。
- [ ] 添加 package-boundary check script。

### Verify

- [ ] Schema round-trip 覆盖所有合法 shape。
- [ ] 非法 ID、path、binding、mode 和 timestamp 被拒绝。
- [ ] 新增一个 event variant 时，reducer test 必须编译失败或测试失败。
- [ ] Contract 没有 import OMP、SQLite、Git、Discord、React 或 Bun adapter。
- [ ] Type check、lint 和 contract tests 通过。

## 02. `@pico/config`

### Design

- [ ] 定义唯一的 `picoRoot` 输入和 `~/.pico` 默认值。
- [ ] 定义所有派生 path。
- [ ] 定义 `config.toml` key、默认值和 secret reference 语法。
- [ ] 定义 root lock 的 stale-owner 行为。
- [ ] 定义 immutable config output。

### Plan

- [ ] 分开 path construction、TOML decoding、secret loading 和 lock ownership。
- [ ] 列出所有启动失败条件。
- [ ] 保证测试只使用 temporary root。

### Implement

- [ ] 创建 config package。
- [ ] 实现 pico path constructor。
- [ ] 实现严格 TOML Schema。
- [ ] 拒绝 unknown key 和 invalid value。
- [ ] 实现 secret reference loader。
- [ ] 实现 scoped daemon root lock。
- [ ] 不启动任何其他服务。

### Verify

- [ ] Missing config 使用默认值。
- [ ] Valid config 得到 immutable value。
- [ ] Unknown key 和 invalid value 启动失败。
- [ ] Missing secret 启动失败且错误不含 secret 内容。
- [ ] 第二个 daemon owner 无法获取相同 root lock。
- [ ] Stale lock 行为符合设计。

## 03. `@pico/logging`

### Design

- [ ] 定义 structured log record。
- [ ] 定义 component、operation、workspace、chat 和 correlation annotation。
- [ ] 定义 console 和 file sink。
- [ ] 定义每日 rotation 和 30 天 retention。
- [ ] 定义默认 redaction policy。

### Plan

- [ ] 把日志输出、rotation、retention 和 close 分开验证。
- [ ] 使用可控制 clock 和 temporary root。
- [ ] 不要求其他 package import logging package。

### Implement

- [ ] 创建 logging package。
- [ ] 安装 Effect logger layer。
- [ ] 同时输出 console 和 file。
- [ ] 实现 daily rotation。
- [ ] 实现 completed file retention。
- [ ] 通过 Scope flush 和 close。

### Verify

- [ ] Console 和 file 收到同一条 structured record。
- [ ] 日期边界生成新文件。
- [ ] 30 天边界只删除过期 completed file。
- [ ] Secret、auth、完整 prompt、完整 response 和 raw OMP payload 不被记录。
- [ ] Scope close 后所有 log 已 flush。

## 04. `@pico/persistence`

### Design

- [ ] 冻结 Workspace 和 Chat SQL schema。
- [ ] 冻结 foreign key、check constraint 和 partial unique index。
- [ ] 确认 SQLite 不保存 message、tool call 或 event。
- [ ] 定义 append-only migration 规则。
- [ ] 定义稳定 list ordering。

### Plan

- [ ] 每个 migration 单独落地和验证。
- [ ] Repository 方法顺序匹配 contract。
- [ ] SQL row 只在 adapter 内出现。

### Implement

- [ ] 创建 persistence package。
- [ ] 创建 SQLite client layer。
- [ ] 每个 connection 开启 foreign keys。
- [ ] 创建 STRICT tables 和 indexes。
- [ ] 实现 WorkspaceRepository。
- [ ] 实现 ChatRepository。
- [ ] 实现 migration runner。

### Verify

- [ ] Fresh database migration 通过。
- [ ] Reopen database migration 幂等。
- [ ] CRUD、constraint、uniqueness、foreign key 和 ordering 通过。
- [ ] 两个 millisecond timestamp 相同时仍有稳定顺序。
- [ ] Schema 中没有 transcript 或 event table。

## 05. `@pico/worktree`

### Design

- [ ] 定义 `WorktreeManager` 输入和输出。
- [ ] 定义 source ref 的解析时间。
- [ ] 定义 branch `<branchPrefix>/<chatId>`。
- [ ] 定义 path `<picoRoot>/worktrees/<chatId>`。
- [ ] 定义 collision 和 rollback policy。
- [ ] 明确 permanent purge 不在 scope。

### Plan

- [ ] 把 Git inspection、create 和 rollback 分开。
- [ ] 记录本次 operation 创建了哪些资源。
- [ ] 不删除调用前已存在的 branch 或 directory。

### Implement

- [ ] 创建 worktree package。
- [ ] 实现 source ref validation。
- [ ] 实现 branch 和 worktree creation。
- [ ] 返回 resolved cwd 和 branch。
- [ ] 实现 operation-local rollback。

### Verify

- [ ] Temporary Git repo 创建 worktree 成功。
- [ ] Invalid source ref 返回 boundary error。
- [ ] Branch collision 和 path collision 不破坏已有资源。
- [ ] 中途失败只清理本次创建的资源。
- [ ] Regular Workspace 不调用 Git。

## 06. `@pico/omp`

### Design

- [ ] 冻结 `AgentRuntime` contract。
- [ ] 冻结 `<sessions>/<chatId>.jsonl` 和 sibling artifact directory。
- [ ] 冻结 OMP `AgentSessionEvent` 到 pico `AgentEvent` 的 selected mapping。
- [ ] 定义 `AgentSnapshot` 如何从 live session 和 cold transcript 构造。
- [ ] 定义 `SessionPool` 的 `Opening | Ready | Closing` ownership state。
- [ ] 定义 idle eviction 条件。
- [ ] 根据 phase 00 spike 冻结 process lifecycle gate。

### Plan

- [ ] 分开 runtime bootstrap、session path、snapshot、event mapping 和 SessionPool。
- [ ] 共享 AuthStorage 和 ModelRegistry。
- [ ] 每个 Chat 使用 private AgentRegistry。
- [ ] 每个 Chat 使用自己的 Settings 和 SessionManager。
- [ ] `async.enabled=false`。
- [ ] 不实现 prompt queue、retry、compaction 或 transcript writer。

### Implement

- [ ] 创建 OMP package。
- [ ] 实现 shared runtime acquisition 和 release。
- [ ] 实现 deterministic session materialize 和 resume。
- [ ] Resume 前检查文件存在，避免 `SessionManager.open` 创建新 transcript。
- [ ] 实现 `sendUserMessage` 或等价 direct steer path。
- [ ] 实现 abort。
- [ ] 实现 synchronous event translation 和 bounded handoff queue。
- [ ] 实现 live 和 cold `AgentSnapshot`。
- [ ] 实现 coalesced open 和 one-writer SessionPool。
- [ ] 实现 idle eviction 和 scoped shutdown。

### Verify

- [ ] 创建、关闭和 reopen 保持 transcript。
- [ ] Artifact 和 subagent 路径符合 OMP 18.0.10。
- [ ] OMP type 不越过 package boundary。
- [ ] 两个 Chat 同时运行。
- [ ] 同一个 Chat 的并发 open 只创建一个 session。
- [ ] 运行中 send 进入 steer，不返回 busy。
- [ ] Abort、retry 和 compaction event mapping 正确。
- [ ] Eviction 不 archive，也不删除 JSONL 或 worktree。
- [ ] Dispose isolation 符合 phase 00 结论。

## 07. `@pico/application`

### Design

- [ ] 冻结 Workspace use case。
- [ ] 冻结 Chat create、resume、send、abort、archive 和 watch use case。
- [ ] 定义 regular 和 worktree Chat 创建顺序。
- [ ] 定义 foreign binding idempotency。
- [ ] 定义 rollback 顺序和 primary error preservation。
- [ ] 定义 archive during active turn 行为。

### Plan

- [ ] 每个 use case 只依赖 contract port。
- [ ] 一次 change 最多涉及一个 use case 和对应 tests。
- [ ] Adapter 不参与跨资源排序。

### Implement

- [ ] 创建 application package 和 `make`。
- [ ] 实现 Workspace operations。
- [ ] 实现 regular Chat creation。
- [ ] 实现 worktree Chat creation。
- [ ] 实现 resume。
- [ ] 实现单一 `SendMessage`。运行中由 OMP adapter steer。
- [ ] 实现 abort。
- [ ] 实现 archive。
- [ ] 实现 watch snapshot 和 event stream orchestration。

### Verify

- [ ] Fake port test 证明调用顺序。
- [ ] Failure test 证明 reverse rollback。
- [ ] Uniqueness race 返回 winner，不留下本次资源。
- [ ] Workspace cwd 修改不改变已有 Chat cwd。
- [ ] 运行中 send 进入 OMP steer queue，pico 不维护第二个 queue。
- [ ] Archive 保留 transcript 和 worktree。
- [ ] Application 没有 import adapter implementation。

## 08. `@pico/rpc`

### Design

- [ ] 冻结 `PicoClient` implementation boundary。
- [ ] 冻结一页一条 WebSocket。
- [ ] 冻结 `WatchChats({ chatIds })`。
- [ ] 定义 snapshot-first、future-event-after 的 stream contract。
- [ ] 定义 cancellation、overflow 和 reconnect 行为。
- [ ] 不提供 leaf event type filter。

### Plan

- [ ] Client 和 server 放在独立 module。
- [ ] RPC procedure 只从 contract group 生成。
- [ ] Server handler 只调用 injected `PicoApplication`。
- [ ] Transport error 和 product error 不混在一起。

### Implement

- [ ] 创建 RPC package。
- [ ] 实现 Effect WebSocket server protocol layer。
- [ ] 实现 browser client protocol layer。
- [ ] 实现 unary query 和 command handlers。
- [ ] 实现 `WatchChats` stream。
- [ ] 实现 cancellation cleanup。
- [ ] 实现 bounded OMP handoff overflow error。

### Verify

- [ ] Loopback unary query 和 command 通过。
- [ ] 一条 socket 同时承载多个 RPC request。
- [ ] Watch 只发送 requested Chat。
- [ ] 每个 Chat 的 event 顺序稳定。
- [ ] Snapshot 和 future event 之间没有 gap。
- [ ] Cancel 后 server subscription 被释放。
- [ ] Overflow 后客户端能重新获取 snapshot。

## 09. `@pico/frontend-state`

### Design

- [ ] 冻结 `WatchState = ReadonlyMap<ChatId, AgentState>`。
- [ ] 定义 `reduceWatchItem`。
- [ ] 列出真正 writable 的本地 state。
  - [ ] Per-chat draft。
  - [ ] Router 没有提供时的 watched IDs。
  - [ ] RPC action input。
- [ ] 列出所有 derived state。
  - [ ] Selected Chat。
  - [ ] Timeline。
  - [ ] Agent status。
  - [ ] Partial message。
  - [ ] Running tools。
  - [ ] Retry 和 compaction presentation。
  - [ ] Loading 和 failure。
- [ ] 定义 `PicoClient` injection，不 import RPC implementation。

### Plan

- [ ] 一个 page-scoped AtomRegistry。
- [ ] 一个 continuous watch stream atom。
- [ ] `Stream.scan` 产生唯一 remote cache。
- [ ] `Atom.family` 只用于 per-chat draft 和有实际订阅价值的 selector。
- [ ] `Atom.map` 派生 UI state。
- [ ] 不创建 pico hook wrapper。

### Implement

- [ ] 创建 frontend-state package。
- [ ] 实现 client runtime constructor。
- [ ] 实现 watch stream atom。
- [ ] 使用 `PicoRpc.runtime.atom` 连续消费 raw RPC stream，不使用需要手动 pull 的 streaming `query`。
- [ ] 实现 snapshot replace 和 event reducer。
- [ ] 实现 per-chat draft atom。
- [ ] 实现 send、abort 和 archive action。
- [ ] 实现 narrow derived atoms。
- [ ] 实现 reconnect 和 overflow refresh。

### Verify

- [ ] Reducer 对每个 event leaf 都有 exhaustive case。
- [ ] Snapshot 整体替换 stale Chat state。
- [ ] Semantic no-op 保留原 object identity。
- [ ] 没有 duplicated `isRunning`、`isRetrying` 或 `isCompacting` atom。
- [ ] 不同 Chat 的 component update 不触发无关 Chat 重绘。
- [ ] Atom scope 结束会取消 watch stream。

## 10. `apps/daemon`

### Design

- [ ] 冻结 composition graph。
- [ ] 冻结 startup 和 shutdown 顺序。
- [ ] 冻结 static web serving 与 RPC route。
- [ ] 确认 MVP 不加载 Discord layer。

### Plan

- [ ] `main.ts` 只组装 Layer 和运行 scoped program。
- [ ] 所有 handler 和 policy 从 package 提供。
- [ ] Shutdown 依赖 Scope finalizer，不写第二套 cleanup manager。

### Implement

- [ ] 创建 daemon app manifest 和 entry point。
- [ ] 获取 config 和 root lock。
- [ ] 安装 logging。
- [ ] 组装 persistence、worktree、OMP、application 和 RPC。
- [ ] 启动 WebSocket 和 static web serving。
- [ ] 处理 signal 并关闭 Scope。

### Verify

- [ ] 使用 temporary pico root 启动真实 daemon。
- [ ] Health 和 RPC endpoint 可访问。
- [ ] 第二个 daemon 无法使用相同 root。
- [ ] Signal shutdown 释放 session、DB、logger 和 lock。
- [ ] `apps/daemon` 没有业务逻辑测试需求。

## 11. `apps/web`

### Design

- [ ] 设计信息架构、route 和 responsive layout。
- [ ] 设计 Workspace list、Chat list、timeline、composer 和 tool presentation。
- [ ] 设计 loading、offline、reconnecting、retry、compaction、error 和 archive 状态。
- [ ] 设计 running-chat steer 反馈。
- [ ] 先做视觉 prototype，再冻结组件结构。

### Plan

- [ ] `apps/web` 创建 RPC client 并注入 frontend-state。
- [ ] React component 只读 atom 和 dispatch action。
- [ ] Component-local UI state 留在 component。
- [ ] 跨 route 的 product state 留在 frontend-state。
- [ ] 定义 keyboard、focus 和 accessibility 行为。

### Implement

- [ ] 创建 web app shell 和 route。
- [ ] 安装一个 `RegistryProvider`。
- [ ] 实现 Workspace UI。
- [ ] 实现 Chat UI。
- [ ] 实现 transcript 和 tool output UI。
- [ ] 实现 composer、send、steer 和 abort。
- [ ] 实现 reconnect 和 resync presentation。
- [ ] 实现 archive flow。

### Verify

- [ ] 使用 `control-ui` 驱动真实浏览器。
- [ ] 创建 Workspace 和普通 Chat。
- [ ] 创建 worktree Chat。
- [ ] 发送第一条消息。
- [ ] Agent 运行中发送 steer。
- [ ] 同时切换和观察多个 Chat。
- [ ] 断开并恢复 WebSocket。
- [ ] Archive 后 transcript 仍可读取。
- [ ] Keyboard 和 screen-reader 基本路径可用。
- [ ] 没有持续 repaint 或无关 Chat 重绘。

## 12. MVP end-to-end gate

### Design

- [ ] 冻结 MVP acceptance checklist。
- [ ] 冻结不属于 MVP 的列表。

### Plan

- [ ] 使用全新 temporary pico root。
- [ ] 使用真实 daemon、RPC、OMP SDK 和 browser。
- [ ] 不使用 mock 替代跨 package 路径。

### Implement

- [ ] 清理 spike-only code 和临时兼容路径。
- [ ] 更新 design 和运行文档。
- [ ] 运行 `/deslop` 检查 diff。
- [ ] 运行 `/no-comments` 检查 review surface。

### Verify

- [ ] Static type check、lint 和 package tests 通过。
- [ ] 全新 root 完成 create、send、steer、abort、reconnect、restart 和 archive。
- [ ] 两个 Chat 同时运行。
- [ ] Worktree Chat 使用独立 branch 和 cwd。
- [ ] SQLite 没有 transcript 或 event 副本。
- [ ] Daemon 仍然只有 composition 和 process lifetime。
- [ ] 所有 package import 符合 DAG。
- [ ] MVP 不包含 Discord runtime 和 permanent purge。

## 13. `@pico/discord`, post-MVP

### Design

- [ ] 冻结 channel 到 Workspace、thread 到 Chat 的映射。
- [ ] 冻结 Discord send、edit、rate limit、retry 和 reconnect policy。
- [ ] 冻结 attachment 和 message size policy。
- [ ] 冻结 error presentation。

### Plan

- [ ] Discord package 只依赖 contract 和 Discordeno。
- [ ] 接收 injected `PicoApplication`。
- [ ] 不 import RPC、OMP、persistence、worktree、config 或 logging package。
- [ ] Daemon 只增加一个 optional Layer。

### Implement

- [ ] 创建 Discord package。
- [ ] 实现 gateway 和 REST lifecycle。
- [ ] 实现 channel 和 thread event mapping。
- [ ] 实现 inbound message 到 `SendMessage`。
- [ ] 实现运行中 message 的 steer。
- [ ] 实现 pico output 到 Discord message。
- [ ] 通过 config 和 secret 启用 optional layer。

### Verify

- [ ] Adapter tests 覆盖 idempotent event mapping。
- [ ] Credential-gated smoke 覆盖 channel、thread、send、steer 和 response。
- [ ] Gateway reconnect 不重复创建 Chat。
- [ ] Shutdown 关闭 Discord client。
- [ ] Native web 路径不依赖 Discord package。