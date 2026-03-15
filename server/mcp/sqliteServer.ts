import fs from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import initSqlJs from "sql.js";
import { z } from "zod/v3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

function parseDbPath(argv: string[]) {
  const idx = argv.indexOf("--db");
  if (idx === -1) return path.resolve(process.cwd(), "data", "agent.sqlite");
  const v = argv[idx + 1];
  if (!v) return path.resolve(process.cwd(), "data", "agent.sqlite");
  return path.isAbsolute(v) ? v : path.resolve(process.cwd(), v);
}

async function loadDb(SQL: any, filePath: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) return new SQL.Database();
  const buf = await readFile(filePath);
  return new SQL.Database(new Uint8Array(buf));
}

async function saveDb(db: any, filePath: string) {
  const bytes = db.export();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.from(bytes));
}

function isSelect(sql: string) {
  return /^\s*select\b/i.test(sql);
}

const dbPath = parseDbPath(process.argv);

const SQL = await initSqlJs({
  locateFile(file: string) {
    return path.resolve(process.cwd(), "node_modules", "sql.js", "dist", file);
  }
});

const db = await loadDb(SQL, dbPath);

const server = new McpServer({ name: "sqlite-mcp", version: "0.1.0" });

(server as any).registerTool(
  "sqlite_ddl",
  {
    title: "SQLite DDL",
    description: "Execute a DDL statement (CREATE/ALTER/DROP).",
    inputSchema: {
      query: z.string().min(1),
      parameters: z.array(z.any()).optional()
    }
  },
  async (args: { query: string; parameters?: unknown[] }) => {
    const { query, parameters } = args;
    db.run(query, Array.isArray(parameters) ? parameters : []);
    await saveDb(db, dbPath);
    return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
  }
);

(server as any).registerTool(
  "sqlite_insert",
  {
    title: "SQLite Insert/Write",
    description: "Execute a write statement (INSERT/UPDATE/DELETE).",
    inputSchema: {
      query: z.string().min(1),
      parameters: z.array(z.any()).optional()
    }
  },
  async (args: { query: string; parameters?: unknown[] }) => {
    const { query, parameters } = args;
    db.run(query, Array.isArray(parameters) ? parameters : []);
    await saveDb(db, dbPath);
    const rows = db.exec("SELECT changes() AS affected_rows");
    const affected = rows?.[0]?.values?.[0]?.[0] ?? 0;
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, affected_rows: affected }) }] };
  }
);

(server as any).registerTool(
  "sqlite_query",
  {
    title: "SQLite Query",
    description: "Execute a SELECT query.",
    inputSchema: {
      query: z.string().min(1),
      parameters: z.array(z.any()).optional()
    }
  },
  async (args: { query: string; parameters?: unknown[] }) => {
    const { query, parameters } = args;
    if (!isSelect(query)) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Only SELECT is allowed" }) }],
        isError: true
      };
    }
    const stmt = db.prepare(query);
    stmt.bind(Array.isArray(parameters) ? parameters : []);
    const rows: any[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, rows }) }] };
  }
);

await server.connect(new StdioServerTransport());
