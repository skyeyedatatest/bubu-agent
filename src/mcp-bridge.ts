import fs from "fs/promises";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp";
import { registerSkill } from "./skills";
import { MCP_CONFIG_PATH } from "./paths";

// ====================== 类型定义 ======================
type StdioConfig = {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

type StreamableHttpConfig = {
  type: "streamable_http";
  url: string;
  headers?: Record<string, string>;
};

type MCPServerConfig = StdioConfig | StreamableHttpConfig;

type MCPServersConfig = {
  mcpServers: Record<string, MCPServerConfig>;
};

// ====================== 生命周期管理 ======================
const activeClients: Client[] = [];

/**
 * 读取 mcp_servers.json，连接所有 MCP server，
 * 并将其暴露的工具自动注册为 Skill。
 *
 * 工具名称格式：<serverName>__<toolName>
 * 例如：filesystem__read_file
 */
export async function loadMCPBridge(configPath: string = MCP_CONFIG_PATH) {
  let config: MCPServersConfig;
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    config = JSON.parse(raw) as MCPServersConfig;
  } catch {
    return; // 配置文件不存在，静默跳过
  }

  const servers = Object.entries(config.mcpServers ?? {});
  if (servers.length === 0) return;

  console.log(`\n🌐 发现 ${servers.length} 个第三方 MCP server，开始连接...`);

  for (const [name, cfg] of servers) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let transport: any;
      if (cfg.type === "streamable_http") {
        transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
          requestInit: { headers: cfg.headers ?? {} },
        });
      } else {
        transport = new StdioClientTransport({
          command: cfg.command,
          args: cfg.args ?? [],
          env: {
            ...(process.env as Record<string, string>),
            ...(cfg.env ?? {}),
          },
        });
      }

      const client = new Client({ name: "my-agent", version: "1.0.0" });
      await client.connect(transport);
      activeClients.push(client);

      const { tools } = await client.listTools();

      for (const tool of tools) {
        registerSkill({
          // 加前缀避免与内置 skill 冲突
          name: `${name}__${tool.name}`,
          description: `[MCP:${name}] ${tool.description ?? tool.name}`,
          input_schema: tool.inputSchema as Record<string, any>,
          handler: async (args) => {
            const res = await client.callTool({
              name: tool.name,
              arguments: args,
            });
            return (res.content as any[])
              .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
              .join("\n");
          },
        });
      }

      console.log(`  ✅ ${name} → 注册 ${tools.length} 个工具`);
    } catch (e: any) {
      console.error(`  ❌ 连接失败：${name} — ${e.message}`);
    }
  }
}

/** 关闭所有 MCP server 连接 */
export async function closeMCPBridge() {
  await Promise.allSettled(activeClients.map((c) => c.close()));
  activeClients.length = 0;
}
