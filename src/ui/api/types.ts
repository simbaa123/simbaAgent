export type User = {
  userId: string;
  nameMasked: string;
  phoneMasked: string;
  phoneLast4: string;
  createdAt: string;
  riskFlags: string[];
};

export type OrderSummary = {
  orderId: string;
  orderNo: string;
  userId: string;
  status: "paid" | "shipped" | "delivered" | "cancelled";
  paidAt: string;
  totalAmount: number;
  currency: string;
  itemsSummary: string;
};

export type OrderItem = {
  skuId: string;
  title: string;
  qty: number;
  unitPrice: number;
};

export type OrderDetail = {
  orderId: string;
  orderNo: string;
  userId: string;
  status: "paid" | "shipped" | "delivered" | "cancelled";
  paidAt: string;
  goodsAmount: number;
  shippingFee: number;
  discountAmount: number;
  totalAmount: number;
  currency: string;
  receiver: {
    receiverNameMasked: string;
    receiverPhoneMasked: string;
    addressMasked: string;
  };
  items: OrderItem[];
  shipmentIds: string[];
  aftersaleStatus: "none" | "in_progress" | "completed";
};

export type ShipmentEvent = {
  time: string;
  location: string;
  description: string;
  code: string | null;
};

export type Shipment = {
  shipmentId: string;
  carrier: string;
  trackingNoMasked: string;
  status: "in_transit" | "delivered" | "exception" | "returned";
  shippedAt: string;
  deliveredAt: string | null;
  exceptionCode: string | null;
  events: ShipmentEvent[];
};

export type KbArticle = {
  articleId: string;
  title: string;
  content: string;
  tags: string[];
  updatedAt: string;
};

export type Conversation = {
  conversationId: string;
  createdAt: string;
  status: "open" | "resolved";
  channel: "web" | "phone" | "other";
  assigneeId: string | null;
  linkedUserId: string | null;
  linkedOrderId: string | null;
};

export type Citation = {
  type: "order_field" | "kb";
  ref: string;
  quote: string;
};

export type Message = {
  messageId: string;
  conversationId: string;
  role: "user" | "agent" | "cs";
  content: string;
  createdAt: string;
  citations: Citation[];
};

export type ToolCallLog = {
  toolCallId: string;
  traceId: string;
  conversationId: string;
  stepId: string;
  toolName: string;
  inputRedacted: unknown;
  outputRedacted: unknown;
  status: "success" | "fail";
  latencyMs: number;
  error: { code: string; message: string } | null;
  createdAt: string;
};

export type SampleData = {
  users: User[];
  orders: OrderSummary[];
  orderDetails: OrderDetail[];
  shipments: Shipment[];
  kbArticles: KbArticle[];
  conversations: Conversation[];
  messages: Message[];
  toolCalls: ToolCallLog[];
  indexes: {
    ordersByOrderNo: Record<string, string>;
    usersByPhoneLast4: Record<string, string[]>;
    ordersByUserId: Record<string, string[]>;
  };
};

