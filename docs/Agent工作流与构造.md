# Agent 工作流与构造（simbaAgent）

本文描述本项目中 Agent 的构造方式与端到端工作流，重点讲清楚：入口、SSE 事件协议、LangChain 组装、Tools 设计、Human-in-the-loop（确认/选择）、以及 MCP 扩展。

## 1. Agent 在项目中的位置

- 前端工作台：Inbox/Console 两页，Console 负责“发起对话 + 读取流式事件 + 渲染过程与结果”  
  - 发送与读流：[ConsolePage.vue](file:///d:/code/study/simbaAgent/src/ui/pages/ConsolePage.vue#L124-L205)  
  - SSE 解析器：[sse.js](file:///d:/code/study/simbaAgent/src/ui/pages/console/sse.js)
- 后端入口：`POST /api/chat/stream`（Express + SSE）  
  - 路由入口：[index.ts](file:///d:/code/study/simbaAgent/server/index.ts#L46-L98)
- Agent 主体：`runLangChainAgent`（意图分流 + Tools/MCP/HITL 编排 + LLM 兜底）  
  - Agent 文件：[langchainAgent.ts](file:///d:/code/study/simbaAgent/server/langchainAgent.ts)

## 2. SSE 事件协议（Agent 的“输出通道”）

后端不会只返回一段最终文本，而是持续发送一系列结构化事件，让前端可观测、可交互。

核心事件（前端会消费）：

- `plan_update`：右侧 Plan 步骤（stepId/title/status）  
- `assistant_delta`：增量文本（用来拼接成最终回答）  
- `tool_call` / `tool_result`：工具调用与结果（用于右侧“工具日志”）  
- `need_choice`：需要用户选择（例如命中多个订单时）  
- `need_confirm`：需要用户确认（敏感动作，如退货创建/改地址）  
- `export_ready`：导出文件结果（MCP filesystem）  
- `sqlite_result`：SQLite 查询结果（MCP sqlite）  
- `error`：错误提示  
- `final`：本轮结束（前端停止 loading/streaming 状态）

SSE 底层实现：

- Header 与写帧：[sse.ts](file:///d:/code/study/simbaAgent/server/sse.ts#L1-L19)

## 3. 入口工作流：/api/chat/stream

文件：[index.ts](file:///d:/code/study/simbaAgent/server/index.ts)

请求体（前端发起）：

- `conversationId`：当前会话 ID
- `message`：用户输入文本（包含普通对话或 /export 这类指令）
- `context`：可选上下文
  - `orderId`：前端已选择的订单
  - `confirm`：前端确认弹窗回流 `{ action, payload }`

后端做的事（按顺序）：

1) `initSse(res)` 初始化 SSE  
2) 立刻推送首包 `plan_update(boot)` 与 `ping`（避免“连接建立但一直等不到首包”）  
3) 校验请求体（Zod）  
4) 写入用户消息到内存（用于导出真实对话）  
5) 动态 import 并调用 `runLangChainAgent`  
6) finally 发送 `final` 并 `res.end()`

## 4. Agent 构造：模型 + Tools + 编排器

### 4.1 数据层：演示数据 + 会话消息内存

本项目用 `sample-data.json` 作为演示数据源，启动时清空消息，确保会话从空白开始，同时在运行时把真实对话写入内存，支持 `/export` 导出包含最新对话。

- 数据加载与缓存：[dataStore.ts](file:///d:/code/study/simbaAgent/server/dataStore.ts#L1-L58)
- 追加真实消息：`appendMessage(conversationId, role, content)`

### 4.2 模型层：createModel（OpenAI/DeepSeek 兼容 + streaming）

文件：[langchainAgent.ts](file:///d:/code/study/simbaAgent/server/langchainAgent.ts)

- 使用 `ChatOpenAI`，通过环境变量选择 OpenAI 或 DeepSeek 兼容 endpoint
- `streaming: true` 用于获取 token/delta 增量（在“LLM 兜底分支”转发为 `assistant_delta`）

### 4.3 Tools 层：把业务能力做成可调用工具

Tools 分两类：

- 业务工具：查订单/查物流/查 KB/退货判断/创建退货/改地址
- MCP 工具：导出会话、SQLite 审计查询

本项目的 Tools 有两个关键特征：

1) 工具有明确入参 schema（Zod）
2) 工具内部会发送 `tool_call/tool_result` 事件，让前端可观测

为了减少重复代码，项目抽了一个统一包装器：

- `createToolWrapper`：统一处理 tool_call/tool_result、耗时统计、异常捕获  
  - 位置：[langchainAgent.ts](file:///d:/code/study/simbaAgent/server/langchainAgent.ts#L330-L395)

### 4.4 编排器：runLangChainAgent（按意图执行工作流）

入口函数：

- [runLangChainAgent](file:///d:/code/study/simbaAgent/server/langchainAgent.ts#L810)

它可以看作“工作流引擎”，按优先级处理：

1) MCP 指令（/export /audit /sql）  
2) 一键能力指令（/reply /diagnose）  
3) HITL 回流（context.confirm.action）  
4) 意图分流（物流/退货/改地址/政策）  
5) 其他意图：LLM + Tools 兜底

## 5. 工作流细节（按功能拆解）

### 5.1 MCP 指令：/export /audit /sql

特点：不走 LLM，直接执行 MCP 工具并返回结构化结果。

- 解析与执行：[handleMcpCommands](file:///d:/code/study/simbaAgent/server/langchainAgent.ts#L624-L671)
- /export：filesystem 写入 `exports/*.md|json`，并发送 `export_ready`
- /audit /sql：sqlite 查询，发送 `sqlite_result`

### 5.2 一键生成客服回复：/reply

目标：把右侧“数据”转成可复制话术，减少客服编辑成本。

输出：简短版 / 标准版 / 详细版（都包含订单号、承运商、最新轨迹、下一步建议）。

- 文案生成函数：[buildCsReplyText](file:///d:/code/study/simbaAgent/server/langchainAgent.ts#L725-L741)
- 指令入口：[langchainAgent.ts](file:///d:/code/study/simbaAgent/server/langchainAgent.ts#L851-L879)

数据来源：

- 订单：`getOrderDetail`（优先 context.orderId，其次 linkedOrderId）
- 物流：从订单 shipmentIds 找到最新包裹（本地数据演示）

### 5.3 物流异常诊断 + SOP：/diagnose

目标：输出“结论 + SOP 下一步”，体现从数据到决策的能力。

诊断逻辑（规则化、可解释）：

- 无包裹：`no_shipment`
- 物流异常：`exception`
- 48 小时无更新：`stalled_48h`
- 已签收但投诉未收到：`delivered`
- 其他：`normal`

核心函数：

- 诊断：[inferShipmentIssue](file:///d:/code/study/simbaAgent/server/langchainAgent.ts#L681-L698)
- SOP 文本：[buildSopText](file:///d:/code/study/simbaAgent/server/langchainAgent.ts#L700-L723)
- 指令入口：[langchainAgent.ts](file:///d:/code/study/simbaAgent/server/langchainAgent.ts#L881-L904)

### 5.4 Human-in-the-loop（HITL）：need_choice / need_confirm

HITL 用于保证敏感动作不被模型直接执行，而是“先提示 → 用户确认 → 再执行”。

#### need_choice：多订单命中时让用户选择

- 后端发送 `need_choice`（带 options）
- 前端弹出订单选择弹窗，用户选中后再次请求 `/api/chat/stream`，把 `context.orderId` 带回

相关代码：

- 后端触发：[resolveOrderIdOrAsk](file:///d:/code/study/simbaAgent/server/langchainAgent.ts#L673-L733)
- 前端回传 context：[ConsolePage.vue](file:///d:/code/study/simbaAgent/src/ui/pages/ConsolePage.vue#L222-L226)

#### need_confirm：敏感动作确认（退货创建、改地址）

- 后端发送 `need_confirm`（带 action + details）
- 前端弹出 ConfirmModal，用户点确认后回传 `context.confirm`
- 后端匹配 action 执行对应工具，返回结果文本

相关代码：

- 前端回传 confirm：[ConsolePage.vue](file:///d:/code/study/simbaAgent/src/ui/pages/ConsolePage.vue#L233-L249)
- 后端处理 confirm（退货/改地址）：[langchainAgent.ts](file:///d:/code/study/simbaAgent/server/langchainAgent.ts#L906)

### 5.5 业务意图分流：物流 / 退货 / 改地址 / 政策

除了一键指令外，Agent 还支持自然语言触发的流程化分支：

- 物流：查订单 → 查详情 → 查轨迹 → 输出摘要与建议
- 退货：补齐订单 → 判断可退 → need_confirm → 创建退货
- 改地址：补齐订单 → 判断状态（paid 才可改）→ need_confirm → 修改地址
- 政策：kbSearch 命中 → 输出条款引用与片段（RAG 演示）

这些分支的共同特点：

- 会持续更新 `plan_update`
- 会产出 `tool_call/tool_result`（可观测）
- 只在必要时触发确认/选择弹窗

## 6. 前端如何消费 Agent 工作流

前端的核心不是“等一个 response”，而是持续消费 SSE 事件：

- 读流与 buffer 拼接：[ConsolePage.vue](file:///d:/code/study/simbaAgent/src/ui/pages/ConsolePage.vue#L145-L201)
- 解析器处理半包/粘包：[sse.js](file:///d:/code/study/simbaAgent/src/ui/pages/console/sse.js)
- 事件驱动 UI：\n
  - `plan_update` → 右侧 Plan\n
  - `tool_call/tool_result` → 工具日志\n
  - `assistant_delta` → 更新“预插入的空 agent 消息”内容\n
  - `need_choice/need_confirm` → 弹窗交互\n

## 7. 你可以怎么在面试中讲“Agent 的亮点”

- 可观测：把“LLM 输出”与“工具链路”显式拆为事件流，前端能看到每一步。\n
- 可交互：HITL 协议（need_confirm）把敏感动作从“模型决定”变成“用户确认”。\n
- 可扩展：MCP 把文件/数据库能力变成可插拔工具，无需重写 Agent 框架。\n
- 可落地：新增了“生成客服回复 / 异常诊断+SOP”的一键能力，让 AI 不再复读右侧信息，而是直接减少客服工作量。

