## Plan Mode · 计划小工具

A Finch mini tool that adds a **Plan Mode** button to the Composer toolbar. When enabled, your AI assistant will output a structured plan only — no tool calls, no file writes — and ask for your confirmation before executing.

## Usage

1. Click the **Plan Mode** button (📋) in the Composer toolbar to toggle planning mode on.
2. Send your task as usual. The assistant will reply with a structured plan only.
3. After each reply, a confirmation bar appears at the bottom of the Composer:
   - **Execute** — exits planning mode and sends a follow-up prompt to start execution.
   - **Continue Planning** — keeps planning mode on for another round.
4. Click the button again at any time to exit planning mode manually.

**Home page:** Enabling Plan Mode on the home page applies to the next message only. A new conversation opens with planning mode already active.

## Install

```bash
npx @finch.app/minitools add @finch.app/plan-mode
```

---

为 Finch 对话添加**计划模式**按钮。开启后，AI 助手只会输出方案，不会执行任何操作，每轮回复结束后会询问你是否开始执行。

## 使用方法

1. 点击对话小工具栏中的**计划模式**按钮（📋）开启。
2. 像往常一样发送任务，助手只会输出结构化方案。
3. 每轮回复结束后，Composer 底部出现确认条：
   - **执行** — 关闭计划模式，自动发送一条引导语驱动助手执行方案。
   - **继续计划** — 保持计划模式，继续下一轮计划。
4. 随时再次点击按钮手动退出计划模式。

**首页：** 在首页开启计划模式，仅对下一条消息生效，发送后自动进入新对话并保持计划模式。

## 安装

```bash
npx @finch.app/minitools add @finch.app/plan-mode
```
