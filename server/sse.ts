import type { Response } from "express";

export function initSse(res: Response) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
}

export function sendSseEvent(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function ssePing(res: Response) {
  res.write("event: ping\n");
  res.write(`data: ${JSON.stringify({ t: Date.now() })}\n\n`);
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

