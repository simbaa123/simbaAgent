import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

let loaded = false;

export function loadEnvFiles() {
  if (loaded) return;
  loaded = true;

  const cwd = process.cwd();
  const nodeEnv = process.env.NODE_ENV?.trim() || "";
  const candidates = [
    nodeEnv ? { rel: `.env.${nodeEnv}.local`, override: true } : null,
    nodeEnv ? { rel: `.env.${nodeEnv}`, override: false } : null,
    { rel: ".env.local", override: true },
    { rel: ".env", override: false }
  ].filter(Boolean) as { rel: string; override: boolean }[];

  for (const c of candidates) {
    const filePath = path.resolve(cwd, c.rel);
    if (!fs.existsSync(filePath)) continue;
    dotenv.config({ path: filePath, override: c.override });
  }
}
