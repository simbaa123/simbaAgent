**学习顺序（建议从外到内）**
- 基础设施
  - 先看开发与代理：[vite.config.ts](file:///d:/code/study/simbaAgent/vite.config.ts) 和 [package.json](file:///d:/code/study/simbaAgent/package.json)
    - 前端通过 Vite 代理把 /api 指到 http://127.0.0.1:8787
    - 后端脚本：dev:server 用 tsx 直接运行 TS（无需先编译）
- SSE 基础（必须弄懂）
  - [server/sse.ts](file:///d:/code/study/simbaAgent/server/sse.ts)
    - initSse：设置 text/event-stream/keep-alive/no-cache
    - sendSseEvent：规范化 event/data 帧（每条以空行结尾）
    - sleep：用于演示延时
- 后端入口（HTTP 路由全在这）
  - [server/index.ts](file:///d:/code/study/simbaAgent/server/index.ts)
    - 传统 REST：会话/订单/物流/KB（给前端 Inbox/Console 初始化使用）
    - /api/chat/stream（核心）：解析 body→打开 SSE→分两路
      - USE_LANGCHAIN=1 → 走 LangChain Agent（runLangChainAgent）
      - 否则走脚本化演示分支（仍然发 plan_update/assistant_delta/tool_*）
- Agent 主体（LangChain + 事件派发机制）
  - [server/langchainAgent.ts](file:///d:/code/study/simbaAgent/server/langchainAgent.ts)
    - createModel：DeepSeek/OpenAI 兼容 ChatOpenAI（streaming: true；按 env 选 baseURL、模型名）
    - 工具集（tool(...) 定义并内置事件派发）：
      - searchOrders（按 orderNo/phoneLast4 命中演示数据）
      - getOrderDetail / getShipmentTracking（注入订单/物流数据）
      - kbSearch（RAG 演示：从 kbArticles 做关键词检索，返回 hits + snippet）
      - 可选 MCP 工具：exportConversationToFile / sqliteQuery
      - 每个 tool 内部：emit tool_call → 执行 → emit tool_result（前端工具日志来源）
    - MCP 快捷命令分支（/export、/audit、/sql）：直接调用 MCP 客户端并发送 export_ready/sqlite_result
    - Human-in-the-loop：
      - need_choice（多订单需选择）/ need_confirm（关键动作二次确认）
      - 前端选择/确认后把 context 带回 /api/chat/stream 再走执行分支
    - 流式输出两种路径：
      - agent.streamEvents（on_chat_model_stream）→ sendSseEvent(assistant_delta)
      - fallback agent.invoke → 最后一并下发
    - Plan 可视化：在关键阶段以 plan_update 事件更新 steps（pending/running/done）
- MCP 客户端（可选阅读）
  - [server/mcpClients.ts](file:///d:/code/study/simbaAgent/server/mcpClients.ts)
    - filesystem：受控目录写导出文件
    - sqlite：建表/审计写入/查询，返回文本结果（后续前端解析为 rows）
- 演示数据与索引
  - [sample-data.json](file:///d:/code/study/simbaAgent/data/milestone1/sample-data.json)
    - users/orders/orderDetails/shipments/kbArticles/messages/toolCalls 与 indexes
    - 先扫 kbArticles 结构（RAG hits 字段来源）和 orderDetails/shipments（工具产出）

**通读路径与验证节点**
- 第 1 步：理解 SSE 规范
  - 看 [server/sse.ts](file:///d:/code/study/simbaAgent/server/sse.ts)，用 Postman/浏览器打开 /api/chat/stream 很难直接看明白；建议在 Console 中实际发送消息观察前端 Plan/工具日志/assistant_delta 的联动。
- 第 2 步：/api/chat/stream 入口（index.ts）
  - 找到 USE_LANGCHAIN 分支点，确认 invalid body 与缺少 key 时如何下发 error/final。
  - 在非 Agent 演示分支里关注如何组织 plan_update/assistant_delta/tool_* 的“节奏与顺序”。
- 第 3 步：Agent 主体（langchainAgent.ts）
  - 先读 createModel（要知道它为何 streaming=true、maxRetries/timeout 的默认）
  - 逐个读工具（searchOrders/getOrderDetail/getShipmentTracking/kbSearch），理解 emitToolCall/emitToolResult 的统一包装
  - 阅读 MCP 三个命令路径 /export /audit /sql，理解何时发 export_ready/sqlite_result
  - 查找 need_choice/need_confirm 的触发条件与数据结构（前端弹窗字段从何而来）
  - 最后看 streamEvents 与 fallback invoke 的差异（何时用哪一个）
- 第 4 步：MCP 客户端（mcpClients.ts）
  - 了解封装边界与受控目录/SQL 安全（只允许 SELECT），知道你为何能在前端看到“导出路径/表格结果”
- 第 5 步：数据（sample-data.json）
  - 对照工具实现，快速定位 orderId/shipmentId/kb articleId 在数据里的形态

**自测脚本（配合前端 Console）**
- “物流”问题：触发 getOrderDetail/getShipmentTracking → 右侧订单/物流更新、工具日志显示 tool_call/result
- “政策/SOP/退货”问题：触发 kbSearch → KB 引用卡片出现（含 articleId/title/snippet）
- “/export md”：“导出结果卡片”显示 path，可点击复制
- “/audit”：“SQLite 结果”表出现（头/行数正确）
- “我退货”：触发 need_confirm → 点确认 → 继续流式回执（创建退货申请）

**建议的阅读粒度（每步 10~15 分钟）**
- A. sse.ts → index.ts（/api/chat/stream 的分支点）→ runLangChainAgent 头尾（createModel + streamEvents）
- B. tools 四件套（searchOrders/getOrderDetail/getShipmentTracking/kbSearch）→ 观察 tool_call/tool_result 是如何拼装
- C. MCP 三命令（/export、/audit、/sql）→ 看 export_ready/sqlite_result 的载荷结构
- D. need_choice/need_confirm 两条路径 → 回到前端确认 OrderChoiceModal/ConfirmModal 的字段使用是否一致
- E. sample-data.json 对应字段查验（尤其 kbArticles/snippet 与 shipments/events）

**理解到位后的“能答上来”要点**
- 为什么用 fetch + ReadableStream + 自定义解析（需要 POST/body + 可控解析/容错）
- 为什么先插“空 agent 消息”做承载点（稳定 DOM/滚动/定位）
- 事件规范：plan_update / assistant_delta / tool_call|tool_result / need_* / export_ready / sqlite_result / error / final
- 工具日志如何“可观测”（脱敏 inputRedacted/outputRedacted + latency + stepId/traceId）
- RAG 演示为何可替换为真正向量检索（前端协议与卡片不变，后端实现可换）

如果需要，我可以按你理解的节奏把 langchainAgent.ts 的关键段落逐块贴出讲解（工具封装模板 / MCP 调用封装 / streamEvents 的事件形态）。