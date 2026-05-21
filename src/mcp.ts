import fs from "fs/promises";
import path from "path";

const WORK_DIR = process.cwd();

// ====================== 类型定义 ======================
export type MCPRequest = {
  method: string;
  params: Record<string, any>;
};

export type MCPResponse = {
  result?: any;
  error?: string;
};

export type MCPHandler = (params: any) => Promise<MCPResponse>;

export type MCPModule = {
  method: string;
  handler: MCPHandler;
};

// ====================== 处理器注册表 ======================
const mcpHandlers: Record<string, MCPHandler> = {};

export function registerMCPMethod(method: string, handler: MCPHandler) {
  if (mcpHandlers[method]) {
    console.warn(`⚠️  MCP 方法 "${method}" 已注册，跳过重复加载`);
    return;
  }
  mcpHandlers[method] = handler;
}

// ====================== 加载第三方 MCP 模块 ======================
/**
 * 从指定目录动态加载第三方 MCP handler 文件。
 *
 * 每个文件需 export default 以下两种格式之一：
 *   - 单个 MCPModule：{ method, handler }
 *   - MCPModule 数组：[{ method, handler }, ...]
 *
 * 示例文件 mcp/weather.ts：
 *   import type { MCPModule } from "../mcp";
 *   const mod: MCPModule = {
 *     method: "weather.get",
 *     handler: async (params) => ({ result: { city: params.city, temp: "25°C" } }),
 *   };
 *   export default mod;
 */
export async function loadExternalMCP(
  mcpDir: string = path.join(process.cwd(), "mcp"),
) {
  try {
    await fs.access(mcpDir);
  } catch {
    return; // mcp 目录不存在，静默跳过
  }

  const files = (await fs.readdir(mcpDir)).filter(
    (f) => f.endsWith(".ts") || f.endsWith(".js"),
  );

  if (files.length === 0) return;

  console.log(`\n🔌 发现 ${files.length} 个第三方 MCP 文件，开始加载...`);

  for (const file of files) {
    const filePath = path.join(mcpDir, file);
    try {
      const mod = await import(filePath);
      const exported: MCPModule | MCPModule[] | undefined =
        mod.default ?? mod.mcpModule ?? mod.mcpModules;

      if (Array.isArray(exported)) {
        let count = 0;
        for (const m of exported) {
          if (isValidMCPModule(m)) {
            registerMCPMethod(m.method, m.handler);
            count++;
          } else {
            console.warn(`⚠️  ${file} 中存在无效 MCP 模块，已跳过`);
          }
        }
        if (count > 0)
          console.log(`  ✅ ${file} → 加载 ${count} 个 MCP 方法`);
      } else if (isValidMCPModule(exported)) {
        registerMCPMethod(exported!.method, exported!.handler);
        console.log(`  ✅ ${file} → 加载 MCP 方法：${exported!.method}`);
      } else {
        console.warn(`  ⚠️  ${file} 未导出合法 MCPModule，已跳过`);
      }
    } catch (e: any) {
      console.error(`  ❌ 加载失败：${file} — ${e.message}`);
    }
  }
}

function isValidMCPModule(m: any): m is MCPModule {
  return m != null && typeof m.method === "string" && typeof m.handler === "function";
}

// ====================== 内置 MCP 方法 ======================
export function initBuiltinMCP() {
  registerMCPMethod("project.listDir", async (params) => {
    const dir = params.dir || WORK_DIR;
    const list = await fs.readdir(dir);
    return { result: list };
  });

  registerMCPMethod("system.info", async () => ({
    result: {
      cwd: WORK_DIR,
      nodeVersion: process.version,
      platform: process.platform,
    },
  }));
}

// ====================== 请求分发 ======================
export async function handleMCP(req: MCPRequest): Promise<MCPResponse> {
  const handler = mcpHandlers[req.method];
  if (!handler) return { error: `未知MCP方法：${req.method}` };
  return await handler(req.params);
}
