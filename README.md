# simbaAgent

一个可演示的电商售后智能客服工作台：前端使用 Vue 3（JavaScript + Vite + Tailwind）提供 Inbox/Console，后端以 SSE 流式推送 Agent 规划、工具调用日志与增量回复，并支持通过 MCP 扩展外部能力（文件导出、SQLite 审计查询）。

## 功能

- 会话工作台：Inbox 会话列表 + Console 单会话处理
- SSE 流式输出：token 级增量回复 + `plan_update/tool_call/tool_result` 可观测事件
- 订单上下文：订单侧栏展示（收货信息脱敏、金额、包裹列表）
- 物流查询：按订单关联包裹展示物流轨迹时间线
- 政策/知识库问答（RAG 演示）：`kbSearch` 检索 KB，命中结果以引用卡片展示（含条款引用与片段）
- 退货闭环：可退判断 → `need_confirm` 二次确认弹窗 → 创建退货申请（演示数据）
- MCP 扩展：
  - 导出会话：一键把当前会话导出到 `exports/*.md|json`
  - 审计查询：把请求写入本地 SQLite，并在 Console 里表格展示最近审计记录

相关说明文档：
- docs/agent-langchain-flow.md（Agent + LangChain + Tools/MCP + RAG 引用卡片）

## 技术栈

- 前端：Vue 3 + Vue Router + JavaScript + Vite + Tailwind CSS
- 后端：Node.js + Express 5（tsx 运行 TypeScript）
- Agent：LangChain（支持 DeepSeek/OpenAI 兼容接口）+ Zod 参数校验
- 实时通信：SSE（Server-Sent Events）
- MCP：
  - `@modelcontextprotocol/sdk`（stdio client/server）
  - filesystem：`@modelcontextprotocol/server-filesystem`
  - sqlite：自建 MCP server（`sql.js` 持久化到 `data/agent.sqlite`）
- 配置：dotenv（自动读取 `.env.local/.env`）

## 快速开始（本地开发）

```bash
npm install
npm run dev
```

- 前端：http://localhost:5173/
- 后端：http://localhost:8787/

## 配置模型与 MCP

推荐把环境变量写到 `.env.local`（服务端启动时会自动读取），避免每次手动设置：

```bash
cp .env.example .env.local
```

在 `.env.local` 填入（示例）：

```bash
USE_LANGCHAIN=1
DEEPSEEK_API_KEY=你的key
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
DEEPSEEK_MODEL=deepseek-chat

USE_MCP=1
MCP_SQLITE_URL=sqlite://./data/agent.sqlite
```

启动后，在 Console 右侧可以直接点击：
- 导出会话（生成导出文件路径，可复制）
- 查看最近审计（表格展示 SQLite rows）

## 生产部署（单端口）

构建并启动（Express 在生产模式下托管 `dist/` 静态资源，同时提供 `/api`）：

```bash
npm install --include=dev
npm run build

NODE_ENV=production SERVE_STATIC=1 npm start
```

默认端口 8787，可通过 `PORT` 覆盖。

## 环境变量说明

- `USE_LANGCHAIN=1`：启用 LangChain Agent
- `DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DEEPSEEK_MODEL`：DeepSeek（OpenAI 兼容）模型配置
- `OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL`：可选 OpenAI 配置（备用）
- `USE_MCP=1`：启用 MCP 扩展能力（导出会话、SQLite 审计）
- `MCP_SQLITE_URL`：SQLite 文件路径（默认 `sqlite://./data/agent.sqlite`）

## 常见问题

- 如果看到 Vite 提示 `http proxy error: /api/*` 或 `ECONNREFUSED 127.0.0.1:8787`：表示后端尚未启动完成。等待后端打印 `[server] http://localhost:8787`，或先单独运行 `npm run dev:server` 再运行 `npm run dev:web`。
