# my_agent

基于 DeepSeek 的本地 AI 编程智能体，支持流式输出、上下文压缩、子 Agent 并行、以及可扩展的 Skill / MCP 插件体系。

## 快速开始

**1. 安装依赖**

```bash
npm install
```

**2. 配置环境变量**

创建 `.env` 文件：

```env
BASE_URL=https://api.deepseek.com
DEEPSEEK_API_KEY=your_api_key
MODEL=deepseek-v4-flash
```

**3. 运行**

```bash
npm run dev
```

在 `index.ts` 中修改 `agentLoop` 的入参即可指定任务：

```typescript
import { agentLoop } from "./agent";

await agentLoop("在 output 目录下创建一个网页贪食蛇游戏");
```

其他可用脚本：

```bash
npm run typecheck   # 仅做类型检查，不运行
npm run build       # 编译到 dist/
```

---

## 项目结构

```
my_agent/
├── agent.ts           # Agent 主循环
├── skills.ts          # Skill 注册/加载体系
├── mcp.ts             # 内置 MCP 注册/加载体系
├── mcp-bridge.ts      # 第三方 MCP server 桥接
├── mcp_servers.json   # 第三方 MCP server 配置
├── index.ts           # 入口
├── skills/            # 自定义 Skill 插件目录（自动加载）
└── mcp/               # 自定义 MCP handler 目录（自动加载）
```

---

## 扩展 Skill

在 `skills/` 目录下新建 `.ts` 文件，`export default` 一个 `Skill` 对象或数组，Agent 启动时自动加载。

**单个 Skill：**

```typescript
// skills/fetch_url.ts
import type { Skill } from "../skills";

const skill: Skill = {
  name: "fetch_url",
  description: "获取指定 URL 的网页内容",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "目标 URL" },
    },
    required: ["url"],
  },
  handler: async (args) => {
    const res = await fetch(args.url);
    return await res.text();
  },
};

export default skill;
```

**多个 Skill（数组）：**

```typescript
// skills/string_utils.ts
import type { Skill } from "../skills";

const skills: Skill[] = [
  {
    name: "to_uppercase",
    description: "将字符串转为大写",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    handler: async (args) => args.text.toUpperCase(),
  },
  {
    name: "count_words",
    description: "统计字符串的单词数",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    handler: async (args) => String(args.text.trim().split(/\s+/).length),
  },
];

export default skills;
```

---

## 扩展 MCP

在 `mcp/` 目录下新建 `.ts` 文件，`export default` 一个 `MCPModule` 对象或数组。

**单个 MCP 方法：**

```typescript
// mcp/weather.ts
import type { MCPModule } from "../mcp";

const mod: MCPModule = {
  method: "weather.get",
  handler: async (params) => {
    const res = await fetch(`https://wttr.in/${params.city}?format=j1`);
    const data = await res.json();
    return { result: data };
  },
};

export default mod;
```

**多个 MCP 方法（数组）：**

```typescript
// mcp/db.ts
import type { MCPModule } from "../mcp";

const modules: MCPModule[] = [
  {
    method: "db.query",
    handler: async (params) => {
      // 执行查询...
      return { result: [] };
    },
  },
  {
    method: "db.ping",
    handler: async () => ({ result: "pong" }),
  },
];

export default modules;
```

---

## 接入第三方 MCP Server

编辑项目根目录的 `mcp_servers.json`，按以下格式添加 MCP server，Agent 启动时会自动连接并将其工具注册为可调用的 Skill。

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "your_token"
      }
    },
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://user:pass@localhost/mydb"]
    }
  }
}
```

注册后的工具名称格式为 `<serverName>__<toolName>`，例如 `filesystem__read_file`。LLM 会自动发现并调用这些工具。

> 所有兼容 [MCP 协议](https://modelcontextprotocol.io) 的 stdio server 均可接入。可在 [mcp.so](https://mcp.so) 或 [smithery.ai](https://smithery.ai) 浏览可用的第三方 server。

---

## 内置能力

### Skills

| 名称          | 描述                         |
| ------------- | ---------------------------- |
| `read_file`   | 读取项目内文件               |
| `write_file`  | 新建或覆盖文件               |
| `delete_file` | 删除文件（需终端确认）       |
| `bash`        | 执行终端命令（高危命令拦截） |
| `grep_search` | 项目内关键词搜索             |

### MCP 方法

| 方法               | 描述             |
| ------------------ | ---------------- |
| `project.listDir`  | 列出目录文件     |
| `system.info`      | 获取系统环境信息 |

---

## 安全机制

- **高危命令黑名单**：`rm -rf /`、`sudo`、`mkfs` 等直接拒绝
- **敏感操作确认**：`rm`、`mv`、`chmod` 等执行前在终端等待 `y/yes` 确认
- **上下文自动压缩**：超过 token 阈值时自动摘要历史，保留最近 10 轮对话
