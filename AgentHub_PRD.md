# AgentHub 产品需求分析（PRD）

# 一、项目定位

## 项目名称

# AgentHub
### Runtime Manager for AI Coding Agents

一句话定义：

> See, control and secure all your AI coding agents in one place.

中文：

> 一个统一管理 AI Coding Agent 的运行时中心。

---

# 二、为什么这个方向有机会

当前开发者电脑里已经开始出现大量 AI Agent：

- Claude Code
- Cursor
- Windsurf
- Cline
- Roo Code
- Gemini CLI
- OpenHands
- MCP Servers
- Local Models

但目前存在巨大问题：

- 权限混乱
- 配置混乱
- MCP 不可信
- Token 消耗不可控
- 不知道 Agent 在后台干什么
- 文件读取不可见
- Shell 执行不可见
- 网络请求不可见
- 多个 Agent 相互冲突

目前还没有真正的：

# “AI Agent OS Layer”

这是核心机会。

---

# 三、产品定位（非常关键）

## 不做：

- AI 安全工具
- MCP 管理器
- Claude 插件
- Cursor 插件

这些都太窄。

---

## 正确定位：

# AI Agent Runtime Layer

类比：

| 时代 | 工具 |
|---|---|
| Docker 时代 | Docker Desktop |
| Python 时代 | Conda |
| Node 时代 | nvm |
| Kubernetes 时代 | Lens |
| AI Agent 时代 | AgentHub |

---

# 四、目标用户

## 第一阶段核心用户

### 高频 AI Coding 用户

包括：

- Claude Code 用户
- Cursor 重度用户
- MCP 玩家
- 独立开发者
- AI Startup 工程师

---

## 用户核心痛点

```txt
装了很多 agent 工具
配置越来越乱
不知道 AI 在后台干啥
不敢给 agent 太高权限
token 疯狂消耗
MCP server 不可信
shell commands 很危险
```

---

# 五、产品整体架构

```txt
┌───────────────────┐
│   Desktop App     │
│  (Tauri + React)  │
└─────────┬─────────┘
          │
┌─────────▼─────────┐
│   Agent Runtime    │
│     Monitor        │
└─────────┬─────────┘
          │
 ┌────────┼─────────┐
 │        │         │
 ▼        ▼         ▼
Claude   Cursor    MCP
Adapter  Adapter   Adapter
```

---

# 六、MVP 核心功能（最重要）

## 核心原则

不要一开始做复杂底层。

先做：

# “视觉冲击 + 高频痛点”

---

# MVP 功能 1：AI Agent Activity Monitor

## 功能描述

实时查看 AI Agent 当前正在执行的行为。

示例：

```txt
Claude Code
├─ Reading: ./src
├─ Running: npm test
├─ Network: api.anthropic.com
└─ Risk: LOW

Cursor
├─ Accessing: ~/.ssh
├─ MCP: filesystem
└─ Risk: HIGH
```

---

## 价值

这是整个产品最核心的传播点。

用户第一次真正：

# “看到 AI 在后台做什么”

---

# MVP 功能 2：AI Timeline

## 功能描述

记录 Agent 的关键行为时间线。

示例：

```txt
10:32 Claude opened .env
10:33 Cursor executed npm install
10:34 MCP github requested repo scope
10:35 Claude attempted rm -rf
```

---

## 价值

这是：

# “AI Observability”

会非常适合 Hacker News 和 GitHub 传播。

---

# MVP 功能 3：Risk Score

## 功能描述

自动分析 Agent 风险评分。

示例：

```txt
Agent Risk Score: 82/100

Critical:
- shell access unrestricted
- MCP filesystem has home directory access
- git push enabled
```

---

## 价值

“评分系统”天然具备传播能力。

---

# MVP 功能 4：一键阻断

## 功能描述

快速关闭高风险能力。

例如：

- Disable shell access
- Block network
- Stop MCP
- Pause Cursor indexing

---

## 注意

第一版不需要真正做到 OS 级拦截。

甚至：

# wrapper + 配置管理即可。

重点是：

# 用户感知。

---

# MVP 功能 5：多 Agent 统一视图

## 功能描述

统一查看：

- Claude
- Cursor
- Gemini CLI
- OpenHands
- MCP

---

## 价值

目前没人能真正做到：

# “统一 AI Agent Dashboard”

这是产品最大的差异化之一。

---

# 七、产品亮点（决定传播）

# 亮点 1：AI Agent Task Manager

一句话：

> Activity Monitor for AI Agents

这是最强传播点。

---

# 亮点 2：Live Agent Monitoring

实时展示：

```txt
Claude is reading:
- package.json
- .env
- ~/.ssh
```

视觉冲击极强。

---

# 亮点 3：MCP 可视化

展示：

```txt
filesystem MCP
├─ read files
├─ shell access
├─ network access
```

解决 MCP 黑盒问题。

---

# 亮点 4：Token / Cost Monitor

示例：

```txt
Today:
Claude: $18
Cursor: $7
OpenAI: $12
```

企业用户会非常关注。

---

# 亮点 5：AI Config Sync

同步：

- Cursor rules
- Claude settings
- prompts
- MCP profiles

类似：

# “dotfiles for AI”

---

# 八、前期最大难点

# 难点 1：没有标准接口

Claude、Cursor、MCP 都不统一。

---

## 正确方案

先：

- parse config
- watch logs
- watch processes

不要：

- kernel hooks
- eBPF
- 系统级 sandbox

---

# 难点 2：行为监控

尤其：

- 文件访问
- shell commands
- network access

---

## 正确方案

第一版做：

# “半真实监控”

例如：

- parse logs
- wrapper commands
- monitor spawned processes

---

# 难点 3：Cursor 不开放

Cursor 内部很多行为无法 hook。

---

## 正确策略

不要依赖 Cursor API。

---

# 难点 4：跨平台

macOS 最容易。

Windows 最难。

---

## 建议

第一版：

# 只做 macOS

这是完全合理的。

---

# 九、技术架构建议

# 桌面端

## 技术栈

- Tauri
- React
- TypeScript

---

## 原因

- 小
- 快
- Rust backend
- 前端适合做视觉化

---

# Runtime Monitoring

第一版：

- process watcher
- log watcher
- config parser

不要先做：

- kernel extension
- eBPF
- 底层系统 hook

---

# 十、产品发展路线图

# Phase 1（0~2个月）

## 目标

做出：

# “AI Agent Activity Monitor”

---

## 核心功能

- Agent Monitor
- Timeline
- Risk Score
- Multi-Agent Dashboard

---

# Phase 2（2~4个月）

## Agent Policy Engine

例如：

```yaml
deny:
  - ~/.ssh/**
  - .env
  - rm -rf
```

---

## 新增能力

- Policy templates
- Team profiles
- Config hardening

---

# Phase 3（4~6个月）

# MCP Ecosystem

## 功能

- verified MCP
- safe MCP profiles
- MCP telemetry
- MCP reviews

---

# Phase 4（6~12个月）

# 企业版能力

## 企业真正需要：

- 审计
- compliance
- governance
- AI activity logs
- token budgets
- access control

---

# Phase 5（长期）

# AI Native Operating Layer

未来可能扩展：

- Agent CPU scheduling
- token budgets
- shared context memory
- agent isolation
- runtime orchestration

---

# 十一、冷启动策略（极重要）

# 第一原则：

## 极度视觉化。

---

# 不要：

- CLI only
- 配置工具
- 纯技术框架

---

# 一定要：

# Desktop App

因为：

# Star 来自视觉传播。

---

# GitHub 首页结构建议

# 第一屏

```txt
See what your AI coding agents are doing in real time.
```

配 GIF：

```txt
Claude reading .env
Cursor spawning shell
MCP requesting filesystem access
```

---

# 第二屏

```txt
Activity Monitor for AI Agents
```

---

# 第三屏

```txt
One dashboard for:
Claude
Cursor
Gemini CLI
OpenHands
MCP
```

---

# 十二、传播策略

## Hacker News 标题建议

- I built a task manager for AI coding agents
- See what Claude Code is doing in real time
- Activity Monitor for AI Agents
- Docker Desktop for AI Agents

---

# 核心传播点

不是技术复杂度。

而是：

# “我第一次看见 AI 在后台到底做了什么”

---

# 十三、最终核心定位

AgentHub 不只是：

- AI 安全工具
- MCP 管理器
- Claude 插件

真正的方向是：

# AI Agent Runtime Layer

或者：

# AI Agent Operating System Entry Point

这是整个项目未来最大的想象空间。
