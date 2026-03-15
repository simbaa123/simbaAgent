# simbaAgent

一个可演示的售后 Agent 工作台（前端 Console + 工具日志 + SSE 流式输出），并提供里程碑式演进：

- 里程碑 1：查物流 / SOP 政策问答（工具日志可观测）
- 里程碑 2：退货申请闭环（可退判断 → 确认弹窗 → 创建退货申请）

## 本地开发

```bash
npm install
npm run dev
```

- 前端：http://localhost:5173/
- 后端：http://localhost:8787/

## 使用 DeepSeek（推荐）

在启动 `npm run dev` 的同一个终端里配置环境变量：

```bash
USE_LANGCHAIN=1
DEEPSEEK_API_KEY=你的key
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
DEEPSEEK_MODEL=deepseek-chat
```

Windows PowerShell 示例：

```powershell
$env:USE_LANGCHAIN="1"
$env:DEEPSEEK_API_KEY="你的key"
$env:DEEPSEEK_BASE_URL="https://api.deepseek.com/v1"
$env:DEEPSEEK_MODEL="deepseek-chat"
npm run dev
```

## 生产部署（单端口）

构建并启动（Express 会在生产模式下托管 dist 静态资源，同时提供 /api）：

```bash
npm install
npm run build

NODE_ENV=production SERVE_STATIC=1 npm start
```

默认端口 8787，可通过 `PORT` 覆盖。

## 环境变量模板

复制 `.env.example` 为你自己的本地文件（不要提交 key）：

```bash
cp .env.example .env.local
```

