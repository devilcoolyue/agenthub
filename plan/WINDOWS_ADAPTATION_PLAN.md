# Windows 适配计划

生成时间：2026-05-22

## 目标

将 AgentHub 从当前以 macOS 为主的实现，逐步适配到 Windows 环境，使其至少具备以下能力：

- Windows 下可编译、可启动 Tauri 桌面应用。
- 能读取 Windows 用户目录中的 Claude Code / Codex 会话日志。
- 能读取、扫描、备份和修复 Windows 用户目录中的 Claude / Codex 配置。
- 能在 Windows Terminal 或 PowerShell 中恢复 Claude / Codex 会话。
- 前端能正确展示 Windows 路径、盘符和反斜杠路径。
- 文档中明确 Windows 的安装、启动和限制。

## 当前状态判断

项目原始实现不是完整 Windows 支持版本。本次适配后，Windows 10 已具备源码运行支持，并已通过本地编译、启动、数据库初始化和用户可用性验证。

已确认的 macOS 假设包括：

- README 中明确写明当前优先支持 macOS。
- 终端恢复逻辑使用 `osascript` 调用 Terminal.app / iTerm。
- 非 macOS 下 `resume_claude_session` / `resume_codex_session` 直接返回不支持。
- 非 macOS 下 `list_available_terminals()` 返回空列表。
- 文档和部分路径展示逻辑包含 `/Users/...` 假设。
- 打包说明以 macOS DMG 为主。

但项目技术栈是 Tauri 2 + Rust + React，具备跨平台基础。Windows 适配主要是平台路径、终端调用、配置路径和验证工作的补齐。

## 本次实施进展

已完成：

- `.claude` / `.codex` 日志与配置路径改为跨平台 `PathBuf::join` 写法。
- Windows 下检测 Windows Terminal (`wt.exe`) 与 PowerShell。
- Windows 下恢复 Claude/Codex 会话会打开 Windows Terminal 或 PowerShell。
- Windows 终端恢复命令支持 PowerShell 参数引用、cwd 切换和代理环境变量。
- 前端路径展示支持 `/Users/...`、`/home/...` 和 `C:\Users\...`。
- README、中文 README 与项目分析文档已补充 Windows 10 源码运行说明。
- Visual Studio Build Tools 2022 C++ 工具链已安装。
- WebView2 Runtime 已检测到。
- Rust MSVC toolchain 已验证为 `stable-x86_64-pc-windows-msvc`。
- `npm run build` 已通过。
- `cargo check` 已通过。
- `cargo test` 已通过。
- `agenthub-tail` 的 `cargo check` 已通过。
- `npm run tauri -- build --no-bundle` 已通过，并生成 `app/src-tauri/target/release/app.exe`。
- `app.exe` 已在 Windows 10 启动，进程响应正常。
- 应用已创建 `C:\Users\fengbaobao\AppData\Roaming\com.agenthub.dev\events.db`。
- 经用户测试，Windows 版本已经可以使用。

后续注意事项：

- 当前机器未检测到 Windows Terminal (`wt.exe`)，会回退到 PowerShell。
- 当前机器已检测到 `claude` 与 `codex` 命令。
- Windows 安装包尚未发布，当前使用源码运行或 `app/src-tauri/target/release/app.exe`。
- 仍建议继续用更多真实 Windows Claude/Codex 会话覆盖 Activity、Backfill、Policy 与 Resume 操作。

## 阶段 1：Windows 基线验证

目标：先确认当前代码在 Windows 上的真实失败点，避免盲目修改。

任务：

1. 安装必要工具：
   - Node.js 18+
   - npm
   - Rust MSVC toolchain
   - WebView2 Runtime
   - Windows Terminal，可选但推荐
2. 在 `app` 目录执行：
   ```bash
   npm install
   npm run build
   ```
3. 在 `app/src-tauri` 目录执行：
   ```bash
   cargo check
   cargo test
   ```
4. 在 `app` 目录尝试完整启动：
   ```bash
   npm run tauri dev
   ```
5. 记录 Windows 编译错误、运行错误和平台能力缺失。

验收标准：

- 前端 `npm run build` 通过。
- Rust 后端至少能 `cargo check`。
- 若 Tauri 启动失败，需要有明确错误清单。

## 阶段 2：抽象平台差异

目标：减少业务代码中的 `cfg(target_os = "macos")` 分散逻辑，为 Windows 实现提供清晰边界。

建议新增目录：

```txt
app/src-tauri/src/platform/
├── mod.rs
├── paths.rs
└── terminal.rs
```

建议抽象内容：

- 用户 home 目录。
- Claude 会话目录。
- Codex 会话目录。
- Claude 配置文件路径。
- Codex 配置文件路径。
- 可用终端列表。
- 终端启动命令。
- shell 参数引用和转义。
- 代理环境变量注入方式。

验收标准：

- macOS 现有行为不变。
- Windows 平台逻辑集中在平台层。
- `commands/terminal.rs` 和 policy 路径扫描不再硬编码具体系统细节。

## 阶段 3：适配 Windows 日志与配置路径

目标：让后端可以在 Windows 用户目录下发现并读取 Agent 日志与配置。

优先支持路径：

```txt
%USERPROFILE%\.claude\projects
%USERPROFILE%\.codex\sessions
%USERPROFILE%\.claude\settings.json
%USERPROFILE%\.claude\settings.local.json
%USERPROFILE%\.claude\hooks.json
%USERPROFILE%\.codex\config.toml
```

任务：

1. 检查 `agent/tail.rs` 是否对路径分隔符有隐含假设。
2. 检查 `agent/claude.rs` 中 Claude cwd 解码逻辑是否适用于 Windows 盘符。
3. 检查 `commands/terminal.rs` 的 `resolve_claude_launch_cwd()`，当前用 `-` 还原 `/`，需要补 Windows cwd 解码策略。
4. 检查 `resolve_codex_launch_cwd()` 是否可直接读取 Windows cwd。
5. 检查 policy 扫描模块是否使用 `dirs::home_dir()` 拼接相对目录，避免硬编码 Unix 路径。

验收标准：

- Windows 下能扫描 `.claude/projects` 与 `.codex/sessions`。
- Windows 下能读取 Claude / Codex 配置。
- cwd 为 `C:\...`、`D:\...` 时不会被错误截断或错误还原。

## 阶段 4：实现 Windows 终端恢复会话

目标：让 Sessions / Session Detail 里的恢复会话功能在 Windows 可用。

优先支持终端：

- Windows Terminal：`wt.exe`
- PowerShell：`powershell.exe`
- cmd：可选兜底

Claude 恢复命令：

```powershell
claude --resume <session_id>
```

Codex 恢复命令：

```powershell
codex resume <session_id>
```

代理环境变量 PowerShell 示例：

```powershell
$env:HTTP_PROXY="http://host:port"
$env:HTTPS_PROXY="http://host:port"
$env:ALL_PROXY="http://host:port"
```

任务：

1. `list_available_terminals()` 在 Windows 下检测 `wt.exe` 和 PowerShell。
2. 新增 Windows 命令引用函数，正确处理空格、引号、中文路径和盘符。
3. Windows Terminal 启动时使用目标 cwd。
4. PowerShell 启动时设置 `-NoExit`，便于用户看到恢复后的会话。
5. 保留 macOS Terminal / iTerm 现有行为。

验收标准：

- 点击恢复 Claude 会话能打开 Windows Terminal/PowerShell 并执行 `claude --resume`。
- 点击恢复 Codex 会话能执行 `codex resume`。
- cwd 包含空格或中文时仍能正常进入目录。
- 配置代理后，恢复终端中能拿到对应环境变量。

## 阶段 5：修正前端 Windows 路径展示

目标：让 UI 对 Windows 路径友好，不再只识别 `/Users/...`。

重点位置：

- `app/src/views/PolicyView.tsx`
- `app/src/utils.ts`
- `app/src/views/SessionsView.tsx`
- `app/src/views/SessionDetailView.tsx`
- 任何对 `/`、`~`、`/Users/` 有直接假设的地方

任务：

1. 提供通用路径脱敏函数，把当前用户 home 显示为 `~`。
2. `shortenCwd()` 同时支持 `/` 和 `\`。
3. Policy 备份历史中正确显示 `C:\Users\name\...`。
4. tooltip 中保留完整原始路径。

验收标准：

- Windows 路径显示不混乱。
- 路径中的反斜杠、盘符、中文不会破坏 UI。
- macOS 路径展示保持原有体验。

## 阶段 6：Windows 打包配置

目标：让项目可以生成 Windows 安装包或可执行产物。

任务：

1. 检查 `app/src-tauri/tauri.conf.json` 的 bundle 配置。
2. 复用现有 `icons/icon.ico`。
3. 增加或验证 Windows 打包目标，例如 nsis / msi。
4. 明确签名状态和未签名安装包提示。

验收标准：

- Windows 下 `npm run tauri build` 能生成可安装或可运行产物。
- README 中说明产物位置和安装方式。

## 阶段 7：功能验证清单

Windows 完整适配完成前，需要逐项验证：

- 应用可以启动。
- SQLite 数据库可以创建。
- Activity 可以接收新事件。
- Backfill 可以导入历史 JSONL。
- Sessions 可以按项目聚合。
- Session Detail 可以打开历史会话。
- Cost 可以统计 usage。
- Policy 可以读取 Claude / Codex 配置。
- Policy 删除前会创建 `.bak` 备份。
- Policy 可以恢复备份。
- FTS 重建可以运行。
- 数据清理可以运行。
- Windows Terminal / PowerShell 恢复会话可用。
- macOS 原有功能没有回归。

## 阶段 8：文档更新

需要更新：

- `README.md`
- `README_CN.md`
- `PROJECT_ANALYSIS_CN.md`

需要新增或补充内容：

- Windows 前置依赖。
- Windows 启动命令。
- Windows 目前支持的功能。
- Windows 仍有限制的功能。
- Windows 常见问题，例如 Rust MSVC、WebView2、`wt.exe`、PATH 中找不到 `claude` 或 `codex`。

## 推荐实施顺序

1. 先安装 Rust 工具链，跑通 `npm run build` 和 `cargo check`。
2. 抽象平台路径和终端层。
3. 适配 Windows 日志、配置和 cwd 解析。
4. 实现 Windows Terminal / PowerShell 恢复会话。
5. 修正前端路径展示。
6. 做完整功能验证。
7. 更新 README 和中文分析文档。

## 风险点

- Claude Code 在 Windows 下的日志目录和 cwd 编码规则可能与 macOS 不完全一致，需要用真实日志样本验证。
- Codex session 文件名和 `session_meta.payload.cwd` 通常更可靠，但也需要真实 Windows 样本确认。
- Windows shell 引用规则比 POSIX 更复杂，恢复会话命令必须重点测试空格、引号、中文路径。
- Policy 写配置属于高风险操作，Windows 下必须确认备份、原子写入和恢复流程。
- Tauri Windows 打包可能需要额外系统依赖或签名流程。
