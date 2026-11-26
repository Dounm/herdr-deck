# Herdr Deck (`karllooki.herdr-deck`)

为 [Herdr](https://herdr.dev) 打造的 **Gruvbox 风格多 Agent 指挥台 / Agent Inbox 弹窗插件**。

按 `prefix + i` 毫秒级呼出 `92% × 88%` 模态控制面板，零上下文切换完成全局 Agent 监控、原地审批与一句话派活，需要深入写代码或看长 diff 时按 `Enter` 精准跳转到对应终端 Pane。

---

## 核心特性

1. **随呼随到、不破坏布局（`prefix + i`）**：
   - 全局会话级 Popup 模态弹窗，在任意 Workspace / Tab 下呼出都不占用额外 Tab 栏位，按 `Esc` / `q` 瞬间收起回到原位。
2. **注意力四级分诊队列（Attention Hierarchy）**：
   - **`! NEEDS YOU`**：处于 `blocked` 阻塞审批或提问的 Agent，置顶高亮并显示等待时长 `⚑ mm:ss`，自动提取底部卡点摘要。
   - **`✓ READY FOR REVIEW`**：刚完成输出等待检阅（`done`），看完右侧快照后可直接按 `m` / `Space` 原地标为已审阅（无需切进终端）。
   - **`↻ WORKING`**：后台推进中的 Agent，通过插件事件钩子实时记录并跳动**本轮 Working 耗时 `↻ mm:ss`**。
   - **`○ IDLE`**：空闲待命的 Agent（支持按 `z` 一键隐藏/展开）。
3. **右侧实时彩色终端快照 + 原地处置（In-place Triage）**：
   - **原地快捷审批**：选中 `NEEDS YOU` 项时，直接按 `y` / `n` / `a` / `1-4` 即可投递审批键，批完自动跳向下一个待办项。
   - **右侧实时按键透传（`Tab` / `i`）**：面对需要方向键选择的复杂弹窗（如 Claude Code / Codex 多选确认框），按 `Tab` 进入透传态，`↑` / `↓` / `Enter` / `Space` 直接驱动右侧 Agent 界面并毫秒级刷新画面。
   - **内联一句话回复 / 派活（`r` 或 `/`）**：底部直接输入一句话通过 `agent.prompt` 发送给选中的 Agent（支持中文输入，若目标处于审批阻塞态会自动拦截防误触）。

---

## 本地开发与安装

```bash
# 1. 安装依赖并执行类型检查 + 单元测试 + 单文件打包
pnpm install
pnpm verify

# 2. 链接本地插件到 Herdr
herdr plugin link /Users/karllooki/workspace/personal/herdr-plugin/herdr-deck
```

在 `~/.config/herdr/config.toml` 中绑定快捷键：

```toml
[[keys.command]]
key = "prefix+i"
type = "plugin_action"
command = "karllooki.herdr-deck.inbox"
description = "Herdr Deck (Agent Inbox)"
```

随后重载配置生效：

```bash
herdr server reload-config
```

---

## 面板快捷键速查

| 按键 | 功能 |
| --- | --- |
| `j` / `k` 或 `↑` / `↓` | 在左侧注意力队列上下切换 Agent，右侧实时刷新终端快照 |
| `Enter` | **Dive In**：跳转到选中 Agent 所在的真实 Terminal Pane 并关闭弹窗 |
| `y` / `n` / `a` / `1-4` | 当选中项处于 `NEEDS YOU` 时，原地投递快捷审批键 |
| `Tab` 或 `i` | 进入**右侧实时按键透传模式**（方向键/回车直接操控审批框，`Esc`/`Tab` 退出） |
| `r` 或 `/` | 唤起底部内联输入框，敲一句话直接发给选中 Agent（`Enter` 发送，`Esc` 取消） |
| `m` 或 `Space` | 在面板内将 `READY FOR REVIEW` 项标记为已阅并移向下一项 |
| `[` / `]` 或 `Ctrl+U` / `Ctrl+D` | 上下滚动右侧终端预览历史 |
| `f` | 循环切换过滤视图（`All` / `Attention` / `Active`） |
| `z` | 展开 / 隐藏 `IDLE` 空闲分组 |
| `q` / `Esc` | 关闭面板回到原终端 |
