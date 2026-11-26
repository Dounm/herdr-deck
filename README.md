# Herdr Deck (`karllooki.herdr-deck`)

一个为 [Herdr](https://herdr.dev) 打造的 **Gruvbox 圆角三区卡片风格多 Agent 控制面板（Agent Inbox Popup）**。

当你在 Herdr 中同时运行多个 coding agents（Claude Code、Codex、Antigravity CLI、OpenCode 等）时，无需在 Workspace / Tab 之间反复跳转：按 `prefix + i` 呼出 `92% × 88%` 模态控制面板，按注意力优先级一眼看清谁卡在审批、谁刚做完、谁正在跑，并支持**原地审批、内联回复、原地重命名 Pane**，需要深度介入时按 `Enter` 瞬时跳入对应终端。

---

## 界面概览

```text
 ◈ HERDR DECK   ! 1 待审批   ✓ 1 待审阅   ⠋ 2 运行中   ○ 3 空闲                  [f] 全部
╭─ Agent 队列 ──────────────── 7/7 ─╮╭─ herdr plugin · misc › 3 › agy ──── ⎇ main *2 ↑1 ─╮
│ ─ ! NEEDS YOU (1) ─────────────── ││  已完成单测与打包，准备执行以下迁移命令：          │
│ ▌! dsh-launcher           ⚑ 01:24 ││                                                   │
│ ▌  claude │ Allow Bash: migrate?  ││  ╭─ Permission Required ────────────────────────╮ │
│                                   ││  │ Bash(pnpm --filter db migrate)               │ │
│ ─ ✓ READY FOR REVIEW (1) ──────── ││  │ ❯ 1. Yes   2. Always allow   3. No           │ │
│  ✓ lifelogging-server     2m ago  ││  ╰──────────────────────────────────────────────╯ │
│    work·agy │ 数据同步与校验完成  ││                                                   │
│                                   │╰───────────────────────────────────────────────────╯
│ ─ ↻ WORKING (2) ───────────────── │╭─ 快速审批 / 回复 ────── [y/n/1-4] 审批 · [Enter] ─╮
│  ⠋ herdr plugin           ↻ 03:18 ││ ❯ 按 [y] 同意 · [n] 拒绝 · [1-4] 选第 N 项        │
│    misc·agy │ 正在构建单文件产物  │╰───────────────────────────────────────────────────╯
│                                   │
│ ─ ○ IDLE (3) ──────────────────── │
│  ○ dotfiles          ⎇ main *1 ↑1 │
│    personal·agy │ Idle at prompt  │
╰───────────────────────────────────╯
 [j/k] 切换  [Enter] 进入终端  [r] 回复  [y/n] 审批  [m] 已阅  [?] 全部快捷键
```

---

## 核心特性

- **注意力四级分诊队列（Attention Hierarchy）**：
  - **`! NEEDS YOU`**：处于 `blocked` 阻塞审批或提问的 Agent，置顶高亮并显示已等待时长 `⚑ mm:ss`，自动从屏幕底部提取卡点摘要。
  - **`✓ READY FOR REVIEW`**：刚完成任务等待检阅（`done`），在右侧看完结果后按 `m` / `Space` 即可原地标记已阅（无需切进终端）。
  - **`↻ WORKING`**：后台推进中的 Agent，通过插件事件钩子精准记录并跳动**本轮 Working 耗时 `↻ mm:ss`**。
  - **`○ IDLE`**：空闲待命的 Agent（支持按 `z` 一键隐藏/展开）。
- **高辨识度命名 + 稳定哈希分色**：
  - 优先展示 `pane.label`（忽略纯数字），缺失时回退为 `agent.name` / 目录末段名 / `workspace` 名，并为不同名称分配稳定的 Gruvbox 亮色，同一 Workspace 下开多个 Agent 也能一眼分辨。
- **多机器（SSH Machines）聚合控制**：
  - 自动发现通过 `herdr machine add` 添加且处于启用状态的远端机器，后台异步并发聚合其所有 Agent 到统一队列（卡片次行与预览栏带 `@machine` 紫色徽章），无需等待远端连接即可秒开本机列表。
  - 支持对远端 Agent 实时预览终端快照、原地审批（`y`/`n`/`1-4`）、内联回复（`r`）和原地重命名（`R`）；远端项禁用 `Enter` 跳转以避免误切本地终端。
- **右侧 ANSI 彩色实时快照（智能软换行）**：
  - 拉取 `recent_unwrapped` 完整逻辑行，按右侧预览卡片宽度自动软换行并跨行延续 ANSI 颜色样式；纯分隔横线自动裁剪为单行不折行。
- **原地处置 + 完美中文输入法体验**：
  - **`y` / `n` / `a` / `1-4`**：对阻塞项直接投递审批键，批完自动跳向下一个待办项。
  - **`r`（或 `/`）**：聚焦右下角内联回复盒，暴露原生终端硬件光标（完美支持 macOS 中文输入法动态拼音预编辑与候选词跟随）并支持行内光标移动编辑，回车通过 `agent.prompt` 派发任务。
  - **`R`（`Shift+r`）**：原地重命名选中 Pane（自动预填当前名称，留空回车清除自定义名称），列表与 Herdr 面板标题同步刷新。
  - **`Enter`**：一键深入进入选中 Agent 的真实终端（支持跨 Workspace 跳转与已聚焦 Pane 瞬间返回）。
- **零闪烁流畅渲染**：
  - 使用 DEC 2026 同步帧输出（BSU/ESU）+ 禁用自动折行（DECAWM off）+ 逐行绝对坐标落点 + 预览缓存与防抖请求代际校验，快速 `j`/`k` 切换丝滑无闪烁、顶部状态栏不抖动。
- **精简底栏 + `?` Cheatsheet**：
  - 底部仅保留高频核心动作，按 `?` 随时呼出居中圆角快捷键速查表。

---

## 环境要求

- **Herdr** `>= 0.9.0`（macOS / Linux）
- **Node.js** `>= 22.0.0`
- **pnpm**（用于安装依赖与 `esbuild` 打包）

---

## 安装与配置

### 1. 从 GitHub 一键安装（推荐）

```bash
herdr plugin install Dounm/herdr-deck
```

### 2. 在 `~/.config/herdr/config.toml` 中绑定快捷键

```toml
[[keys.command]]
key = "prefix+i"
type = "plugin_action"
command = "karllooki.herdr-deck.inbox"
description = "Herdr Deck (Agent Inbox)"
```

重载 Herdr 配置即可生效：

```bash
herdr server reload-config
```

之后在任意 Workspace / Tab 按 **`prefix + i`** 即可呼出 Herdr Deck 弹窗。

---

## 快捷键速查

| 分类 | 按键 | 功能 |
| --- | --- | --- |
| **导航与跳转** | `j` / `k` 或 `↑` / `↓` | 上下切换 Agent，右侧实时预览最新输出 |
| | `g` / `G` | 跳到队列顶部 / 底部 |
| | `Enter` | 深入进入选中 Agent 的真实终端并关闭面板 |
| | `q` / `Esc` | 关闭 Herdr Deck 弹窗 |
| **原地审批与回复** | `y` / `n` / `a` / `1-4` | 选中「待审批」项时直接投递审批按键 |
| | `r` 或 `/` | 聚焦右下角输入框，一句话发给选中 Agent（`Enter` 发送，`Esc` 取消） |
| | `←` / `→` / `Ctrl+A` / `Ctrl+E` | 输入框内移动光标编辑（支持 macOS 中文输入法） |
| | `Ctrl+U` / `Ctrl+W` | 清空光标前文本 / 删除前一个词 |
| **队列与 Pane 管理** | `R`（`Shift+r`） | 原地重命名选中 Pane（自动预填当前名，留空回车清除） |
| | `m` / `Space` | 将「待审阅」项标记为已阅并移向下一待办 |
| | `f` | 循环切换过滤视图（全部 / 仅待办 / 活跃） |
| | `z` | 展开或隐藏 `IDLE` 空闲分组 |
| | `Ctrl+r` | 立即手动刷新全量快照 |
| | `?` | 打开 / 关闭完整快捷键速查表（Cheatsheet） |

---

## 工作原理

- **插件事件钩子**：在 [herdr-plugin.toml](herdr-plugin.toml) 订阅 `pane.agent_status_changed`、`pane.agent_detected`、`pane.closed`，将每个 Pane 进入当前状态的时间戳持久化到 `$HERDR_PLUGIN_STATE_DIR/deck-state.json`，实现无需常驻守护进程的精准 Working / Blocked 计时。
- **直连 Herdr Socket API**：弹窗启动后直接连接 `HERDR_SOCKET_PATH`，通过 `session.snapshot` 秒开渲染，再通过 `events.subscribe` 接收实时状态变更，利用 `pane.read`（`recent_unwrapped` + `ansi`）、`agent.send_keys`、`agent.prompt`、`pane.rename` 与 `agent.focus` 完成闭环操作。
- **单文件零运行时依赖产物**：通过 `esbuild` 将 TypeScript 源码打包为单个 `dist/cli.mjs`，弹窗冷启动控制在毫秒级。

---

## 本地开发

```bash
git clone https://github.com/Dounm/herdr-deck.git
cd herdr-deck

# 安装依赖
pnpm install

# 类型检查 + 单元测试 + esbuild 单文件打包
pnpm verify

# 链接本地插件到 Herdr 进行实时调试
herdr plugin link "$(pwd)"
```

### 目录结构

```text
herdr-deck/
├── herdr-plugin.toml   # Herdr 插件 Manifest（build / startup / events / panes / actions）
├── scripts/build.mjs   # esbuild 单文件打包脚本 -> dist/cli.mjs
├── src/
│   ├── cli.ts          # 命令行入口（startup / event / action / ui）
│   ├── socket-client.ts# Herdr Unix Socket RPC & events.subscribe 客户端
│   ├── state.ts        # Working/Blocked 计时器与已阅状态持久化
│   ├── model.ts        # 注意力四级排序、主标题解析与屏幕摘要清洗
│   ├── ansi.ts         # Gruvbox 24-bit 配色、宽字符宽度、ANSI 软换行与输入框布局
│   ├── keys.ts         # 终端原始键盘输入解析（含 UTF-8/CJK 与控制序列）
│   ├── render.ts       # 圆角三区卡片 TUI、Cheatsheet 浮层与 DEC 2026 同步帧渲染
│   └── app.ts          # 主事件循环、预览防抖缓存、快捷键分发与焦点跳转
└── tests/deck.test.ts  # Node 原生单元测试
```

---

## License

[MIT](LICENSE)
