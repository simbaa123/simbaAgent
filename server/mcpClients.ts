import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function binPath(name: string) {
  const ext = process.platform === "win32" ? ".cmd" : "";
  return path.resolve(process.cwd(), "node_modules", ".bin", `${name}${ext}`);
}

function parseSqliteUrl(url: string) {
  const trimmed = url.trim();
  if (trimmed.startsWith("sqlite://./")) return path.resolve(process.cwd(), trimmed.slice("sqlite://".length));
  if (trimmed.startsWith("sqlite:///")) return trimmed.slice("sqlite://".length);
  if (trimmed.startsWith("sqlite://")) return path.resolve(process.cwd(), trimmed.slice("sqlite://".length));
  return path.resolve(process.cwd(), trimmed);
}

let filesystemClientPromise: Promise<Client> | null = null;
let sqliteClientPromise: Promise<Client> | null = null;

export async function getFilesystemMcpClient(params: { allowedDirs: string[] }) {
  const allowedDirs = (params.allowedDirs ?? []).filter(Boolean);
  if (allowedDirs.length === 0) throw new Error("filesystem MCP requires at least one allowed directory");

  if (!filesystemClientPromise) {
    filesystemClientPromise = (async () => {
      try {
        for (const dir of allowedDirs) fs.mkdirSync(dir, { recursive: true });

        const client = new Client({ name: "simba-agent", version: "0.1.0" });
        const transport = new StdioClientTransport({
          command: binPath("mcp-server-filesystem"),
          args: [...allowedDirs]
        });
        await client.connect(transport);
        return client;
      } catch (e) {
        filesystemClientPromise = null;
        throw e;
      }
    })();
  }

  return filesystemClientPromise;
}

export async function getSqliteMcpClient(params: { url: string }) {
  const url = params.url?.trim();
  if (!url) throw new Error("sqlite MCP requires MCP_SQLITE_URL");

  if (!sqliteClientPromise) {
    sqliteClientPromise = (async () => {
      try {
        const client = new Client({ name: "simba-agent", version: "0.1.0" });
        const dbPath = parseSqliteUrl(url);
        const transport = new StdioClientTransport({
          command: binPath("tsx"),
          args: [path.resolve(process.cwd(), "server", "mcp", "sqliteServer.ts"), "--db", dbPath]
        });
        await client.connect(transport);
        return client;
      } catch (e) {
        sqliteClientPromise = null;
        throw e;
      }
    })();
  }

  return sqliteClientPromise;
}
