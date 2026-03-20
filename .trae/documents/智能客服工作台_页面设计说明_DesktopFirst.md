# 智能客服工作台（Inbox/Console）页面设计说明（Desktop-first）

## 全局设计（跨页面）

### Layout
- 采用 CSS Grid + Flex 混合：整体以“顶部栏 + 内容区”为骨架；内容区按页定义 1 列或 2 列网格。
- 间距使用 4/8/12/16/24 的阶梯；列表与卡片默认 12px gap。

### Meta Information
- 默认 title：`SimbaAgent · 智能售后工作台`
- Inbox title：`SimbaAgent · Inbox`
- Console title：`SimbaAgent · Console`
- description：`电商售后智能客服工作台，支持 SSE 流式可观测与 MCP 扩展能力。`
- Open Graph：沿用 title/description，image 可留空（演示项目）。

### Global Styles（Design Tokens 建议）
- 色彩
  - `--bg`: #ffffff / `--bg-muted`: #fafafa
  - `--text`: #111827 / `--text-muted`: #6b7280
  - `--border`: #e5e7eb
  - `--primary`: #0aa76f（与现有“成功绿”语义一致）
  - `--danger`: #b00020 / `--warning`: #b45309 / `--info`: #2563eb
- 字体
  - font-family：`ui-sans-serif, system-ui`
  - 12/14/16/18/20，标题加粗 700~800。
- 组件通用
  - 圆角：8（卡片/输入/按钮）、12（弹窗）
  - 输入：focus 显示 2px 外描边（primary 透明度 40%）
  - 按钮：主按钮（primary 填充）、次按钮（描边）、危险按钮（danger）
  - Disabled：降低不透明度并取消 hover，光标为 not-allowed
- 可访问性
  - 颜色对比满足可读性（文本/背景对比优先）；交互元素提供 `aria-label` 与可见 focus ring。

---

## 页面 1：Inbox（会话列表）

### Page Structure
- 单列布局：
  1) 页面标题区（标题 + 说明）
  2) 会话列表区（卡片列表）
  3) 反馈区（加载/空/错误）

### Sections & Components
1. 顶部标题区
   - 左：页面标题“售后工单 Inbox（里程碑1）”
   - 下方说明文字，使用 muted 文本色。

2. 会话卡片列表
   - 卡片为整块可点击（Link），hover 提升阴影或边框加深，明确可点击性。
   - 信息层级：
     - 主行：conversationId（粗体） + 状态 Badge（open/resolved）
     - 次行：createdAt（12px，muted）
     - 右侧：order（linkedOrderId）、status、channel（均为次要信息）

3. 状态反馈
   - Loading：骨架屏（3~6 行占位卡片）
   - Empty：空态插画占位（可选）+ 引导文案
   - Error：错误文案 + “重试”按钮（不改变 API，仅重新触发 listConversations）

### Interaction States
- hover：卡片边框从 `--border` 变为更深灰；鼠标变为 pointer。
- focus：键盘 Tab 可聚焦到每个会话卡片，显示 focus ring。

---

## 页面 2：Console（单会话处理台）

### Page Structure
- 双列网格（Desktop）：左 1fr（对话），右 360px（侧栏）；最小高度 0，内部区域独立滚动。
- 左侧：消息区（可滚动） + 输入区（固定在底部）。
- 右侧：订单卡片、物流时间线、MCP 操作与结果卡片、Plan、工具日志（建议分区/折叠）。

### Sections & Components
1. 顶部栏（固定）
   - 左：返回 Inbox、Console 标题、会话 ID（muted）
   - 右：流状态指示（idle/streaming/error）

2. 对话区（左列上半）
   - 消息项：
     - 头部：role + 时间（12px muted）
     - 内容：气泡化（user 右对齐浅底；agent 左对齐白底；cs 中性灰底）
   - 流式输出：agent 消息末尾显示“光标/正在生成”状态（不改变 SSE 协议，仅 UI 标识）。
   - 滚动：
     - 默认新消息自动滚到底部
     - 当用户上滚时进入“阅读模式”，显示“回到底部”按钮

3. 输入区（左列下半固定）
   - 输入框支持长文本换行策略（建议 textarea 自适应 1~5 行），Enter 发送，Shift+Enter 换行。
   - streaming 时禁用输入与发送，并提供原因提示（例如“正在生成回复…”）。

4. 订单侧栏（右列）
   - 订单卡片：订单号/状态（同一行），金额分组展示；收货信息以两行展示（姓名/电话、地址）。
   - 空态：提示“暂无订单上下文（补充订单号/后四位定位）”。

5. 物流轨迹（右列）
   - 每个包裹一个卡片：carrier + status；单号（masked）；事件用时间线布局。
   - 异常（exception）高亮；无事件/未加载显示统一空态。

6. MCP 快捷操作 & 结果
   - 操作区：按钮分组（导出会话/查看最近审计）。
   - 导出结果卡片：显示 format、path、复制路径、清除。
   - SQLite 结果：SQL 折叠区 + 表格（列数限制与横向滚动）。

7. Plan
   - 步骤项显示状态色：pending（muted）、running（info）、done（primary/success）。

8. 工具日志
   - 默认倒序展示，支持折叠详情（input/output 脱敏 JSON）。
   - 关键字段（toolName/status/latency/stepId）对齐，便于快速扫读。

9. 弹窗：need_choice / need_confirm
   - 统一弹窗容器（居中、12px 圆角、遮罩点击行为一致）。
   - need_choice：选项为订单卡片按钮；选中后关闭弹窗并在消息区追加“系统提示”。
   - need_confirm：展示 action 与关键参数摘要；确认按钮为主按钮，取消为次按钮。

### Responsive Behavior
- >= 1200px：双列 1fr + 360px。
- 900~1199px：右侧栏降为 320px，工具日志默认折叠。
- < 900px（非本次重点）：可切换为上下布局（对话在上，侧栏折叠为抽屉）。

### Motion & Transition（可选）
- 卡片 hover：120ms ease-out（阴影/边框）。
- 弹窗出现：opacity + translateY（160ms）。
- “回到底部”按钮：淡入淡出（120ms）。
