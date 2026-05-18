# AgentHub

> 在一个地方查看、控制并加固你的 AI Coding Agents。

AgentHub 是一个本地优先的桌面仪表盘，用来观察 Claude Code、Codex 等 AI Coding Agent 的实际行为：它们读了哪些文件、执行了哪些命令、发起了哪些网络访问、消耗了多少 token，以及配置里是否积累了高风险权限或明文密钥。

它的目标不是替代 Agent，而是成为开发者机器上的 **AI Agent Runtime Layer**：让你看得见、管得住、出问题时能追溯。

## 截图

### 活动监控

![实时事件流与风险评分](assets/activity-monitor.png)

### 会话浏览

![按项目聚合的历史会话](assets/sessions-browser.png)

### 成本统计

![按 Agent 和模型统计的成本面板](assets/cost-dashboard.png)

### 策略加固

![高风险配置检查与一键清理](assets/policy-hardening.png)

---

## 核心功能

- **实时活动监控**：持续监听 Claude Code、Codex 等 Agent 的 JSONL 会话记录，展示 `Read`、`Bash`、`Edit`、`WebFetch` 等关键动作。
- **风险评分**：根据危险 shell 命令、敏感路径访问、网络请求、宽泛权限等信号生成 0-100 的风险分数，高风险活动会在界面中突出显示。
- **会话浏览器**：把历史会话按项目和工作目录聚合，支持懒加载和搜索，方便回看某次 Agent 到底做了什么。
- **成本面板**：按天、Agent 和模型统计 token 使用与估算成本，并区分 input、cache read、cache create、output 等类型。
- **策略与加固**：扫描 `~/.claude/settings.local.json` 与 `~/.codex/config.toml` 中的危险规则，例如明文密码、API token、过宽的 `Bash(curl:*)` 权限，并支持安全删除。
- **历史回填**：从本地 JSONL 源重新扫描历史会话，通过内容哈希保证幂等，可重复执行。
- **安全写入**：修改配置时使用原子写入，并为每次写入保留带时间戳的 `.bak` 备份，支持撤销和恢复。

---

## 不是什么

- **不是沙箱**：AgentHub 不拦截系统调用，也不提供 OS 级隔离。它负责观察 Agent 行为、分析风险，并安全编辑配置。
- **不是云服务**：数据默认保存在本机 SQLite 数据库中，不上传到任何服务器。
- **不是通用跨平台版本**：当前优先支持 macOS，因为目标 Agent 生态主要从 macOS 开始验证。

---

## 下载

预编译的 macOS DMG 发布在 [Releases 页面](https://github.com/devilcoolyue/agenthub/releases)。Apple Silicon 选 `arm64`，Intel 选 `x64`。

当前构建还没有 Apple Developer ID 签名，第一次打开会被 macOS 拦下，提示 **"AgentHub" 已损坏，无法打开**。这不是真的损坏，是 Gatekeeper 拒绝运行未签名的下载文件。把 app 拖进 `/Applications` 后，跑一次清除隔离属性即可：

```bash
xattr -cr /Applications/AgentHub.app
```

之后正常双击打开。后续会做签名 + 公证，免去这一步。

---

## 快速开始（从源码运行）

前置要求：

- macOS
- Node.js 18 或更高版本
- Rust 工具链。如果没有安装，可以通过 `rustup` 安装

从仓库根目录执行：

```bash
cd app
npm install
npm run tauri dev
```

启动后，桌面窗口会打开，并开始监听本机的 Agent 会话目录：

- `~/.claude/projects/`
- `~/.codex/sessions/`

正常使用 Claude Code 或 Codex 时，新事件会自动进入 AgentHub。首次运行时，可以点击界面左上角的 **Backfill from sources**，把已有历史会话导入数据库。该操作是幂等的，可以重复运行。

---

## 常用命令

以下命令默认从仓库根目录执行：

```bash
cd app && npm install
```

安装前端与 Tauri CLI 依赖。

```bash
cd app && npm run dev
```

只启动 Vite 前端开发服务器。

```bash
cd app && npm run tauri dev
```

启动完整 Tauri 桌面应用。

```bash
cd app && npm run build
```

执行 TypeScript 类型检查并构建 Web 产物。

```bash
cd app/src-tauri && cargo test
```

运行 Tauri Rust 后端测试。

```bash
cd agenthub-tail && cargo run -- --from-start
```

运行独立的 JSONL tail 原型，并从历史开头开始读取。

```bash
cd agenthub-tail && cargo test
```

运行原型 crate 的测试。

---

## 架构概览

```txt
┌──────────────────────────────────────┐
│  Tauri 2 桌面应用                    │
│  ┌────────────────────────────────┐  │
│  │  React + TypeScript            │  │
│  │  Activity / Sessions / Cost /  │  │
│  │  Policy                        │  │
│  └─────────────┬──────────────────┘  │
│                │ Tauri IPC           │
│  ┌─────────────▼──────────────────┐  │
│  │  Rust 后端                     │  │
│  │  - Claude / Codex JSONL 适配器 │  │
│  │  - 轮询 tail                   │  │
│  │  - 风险与用量分析              │  │
│  │  - SQLite 持久化               │  │
│  │  - 配置读取与安全写入          │  │
│  └────────────────────────────────┘  │
└──────────────────────────────────────┘
        │                  │
        ▼                  ▼
 ~/.claude/...     ~/.codex/...
```

更详细的模块划分和设计说明见 [`plan/ARCHITECTURE.md`](plan/ARCHITECTURE.md)。

---

## 项目结构

- [`app/`](app/)：主桌面应用。
- [`app/src/`](app/src/)：React + TypeScript 前端代码、样式与共享类型。
- [`app/src-tauri/`](app/src-tauri/)：Tauri Rust 后端，包括 Agent 适配器、SQLite 持久化、风险分析、策略编辑和历史回填。
- [`agenthub-tail/`](agenthub-tail/)：独立 Rust 原型，用于验证 Claude Code 与 Codex JSONL 会话 tail 逻辑。
- [`plan/`](plan/)：产品、架构、路线图和待办说明。
- [`AgentHub_PRD.md`](AgentHub_PRD.md)：产品需求与方向分析。

---

## 当前状态

MVP 已覆盖：

- [x] Activity Monitor
- [x] Session Timeline
- [x] Risk Score
- [x] Policy view 的一键与批量加固
- [x] Claude Code + Codex 多 Agent 监控
- [x] SQLite 持久化与会话聚合
- [x] 成本与 token 统计
- [x] JSONL 历史回填
- [x] hook 解析与风险标记
- [x] 原子配置编辑、备份与恢复

后续规划见 [`plan/ROADMAP.md`](plan/ROADMAP.md)，更细的任务列表见 [`plan/BACKLOG.md`](plan/BACKLOG.md)。

---

## 隐私与安全

- 所有数据默认保存在本机用户目录下的 SQLite 数据库中。
- 没有遥测、分析埋点或自动上传。
- 配置中的敏感值，例如 Authorization header、密码、token，只在本地扫描和标记。
- AgentHub 只会读取必要的 Agent 会话目录和配置文件。
- 只有当你在 Policy 界面中明确触发修复时，AgentHub 才会写入对应配置文件，并在写入前创建备份。

---

## 开发约定

- TypeScript、JSX、CSS 和 JSON 使用 2 空格缩进。
- Rust 使用 `rustfmt` 默认格式。
- React 组件使用 `PascalCase`，hooks 和普通工具函数使用 `camelCase`，Rust 模块使用 `snake_case`。
- 修改解析、风险评分、数据库、策略编辑等逻辑时，应补充靠近代码的聚焦测试。
- UI 修改至少运行 `cd app && npm run build`；Rust 后端修改运行对应的 `cargo test`。

---

## 参考文档

- [`AgentHub_PRD.md`](AgentHub_PRD.md)：产品定位与 MVP 需求
- [`plan/ARCHITECTURE.md`](plan/ARCHITECTURE.md)：架构与模块设计
- [`plan/ROADMAP.md`](plan/ROADMAP.md)：路线图
- [`plan/BACKLOG.md`](plan/BACKLOG.md)：细粒度任务列表

---

## License

MIT — 详见 [`LICENSE`](LICENSE)。
