# Herdr Deck (`karllooki.herdr-deck`)

为 [Herdr](https://herdr.dev) 打造的 **Gruvbox 圆角三区卡片风格 Agent Inbox / 指挥台弹窗插件**。

按 `prefix + i` 毫秒级呼出 `92% × 88%` 模态控制面板，零上下文切换完成全局 Agent 监控、原地审批与一句话派活，需要深入写代码或滚动历史时按 `Enter` 直接进入对应终端 Pane。

---

## 核心特性

1. **高辨识度卡片与稳定分色**：
   - 优先展示 `pane.label`（如 `herdr plugin`、`ovis`、`lifelogging-server read`），缺失时自动回退为目录名或 Workspace 名，并按名称确定性分配 Gruvbox 区分色，同一 Workspace 下的多个 Agent 一眼分辨。
   - **圆角三区布局**：左队列卡片 + 右上实时彩色快照 + 右下固定 3 行内联回复/审批盒，当前聚焦区域自动高亮边框。
2. **注意力四级分诊队列（Attention Hierarchy）**：
   - **`! NEEDS YOU`**：阻塞审批或提问的 Agent，置顶高亮并显示已等待时长 `⚑ mm:ss`，自动提取卡点摘要。
   - **`✓ READY FOR REVIEW`**：刚完成输出等待检阅（`done`），看完右侧快照后可按 `m` / `Space` 原地标为已阅。
   - **`↻ WORKING`**：后台推进中的 Agent，实时跳动本轮耗时 `↻ mm:ss`。
   - **`○ IDLE`**：空闲待命的 Agent（支持按 `z` 一键隐藏/展开）。
3. **零闪烁流畅纯键盘体验**：
   - 使用 DEC 2026 同步帧更新（BSU/ESU）+ 帧级去重 + 预览缓存与防抖竞态保护，快速 `j`/`k` 滑动丝滑无闪烁。
   - 底部只保留核心动作，按 `?` 随时呼出居中快捷键速查表（Cheatsheet）。

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

## 核心快捷键

| 按键 | 功能 |
| --- | --- |
| `j` / `k` 或 `↑` / `↓` | 上下切换 Agent，右侧实时预览最新画面 |
| `Enter` | 进入选中 Agent 的真实终端并关闭面板 |
| `r` 或 `/` | 聚焦右下角输入框，一句话发给选中 Agent（`Enter` 发送，`Esc` 取消，支持中文输入法） |
| `R`（`Shift+r`） | 原地重命名选中 Pane（自动预填当前名称，留空回车清除自定义名） |
| `y` / `n` / `a` / `1-4` | 选中 `NEEDS YOU` 项时原地发送快捷审批键 |
| `m` 或 `Space` | 标记 `READY FOR REVIEW` 项为已阅并移向下一待办 |
| `?` | 打开 / 关闭完整快捷键速查表（Cheatsheet） |
| `q` / `Esc` | 关闭面板回到原终端 |
