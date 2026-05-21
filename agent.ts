import "dotenv/config";
import OpenAI from "openai";
import fs from "fs/promises";
import path from "path";
import { execSync, spawn } from "child_process";
import readline from "readline";

// ====================== 全局配置 ======================
const client = new OpenAI({
  baseURL: process.env.BASE_URL!,
  apiKey: process.env.DEEPSEEK_API_KEY!,
});
const MODEL = process.env.MODEL!;
const WORK_DIR = process.cwd();
const MAX_HISTORY_TOKENS = 600000; // DeepSeek V4-Flash 上下文 1M，最大输出 384K，输入预算约 616K

// 高危命令黑名单
const BAN_CMD = ["rm -rf /", "sudo ", "chmod 777", "> /etc", "mkfs ", "dd if="];
// 需要弹窗确认的敏感操作
const NEED_CONFIRM_CMD = ["rm ", "mv ", "chmod", "npm uninstall", "git reset"];

// ====================== 类型定义 ======================
type ToolCallItem = { id: string; type: "function"; function: { name: string; arguments: string } };

type Message = {
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCallItem[];
  reasoning_content?: string | null; // DeepSeek thinking mode
};

function toAPIMessage(m: Message): any {
  if (m.role === "tool") {
    return { role: "tool", content: m.content ?? "", tool_call_id: m.tool_call_id ?? "" };
  }
  if (m.role === "assistant") {
    return {
      role: "assistant",
      content: m.content ?? "",
      ...(m.reasoning_content != null ? { reasoning_content: m.reasoning_content } : {}),
      ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}),
    };
  }
  return { role: "user", content: m.content ?? "" };
}

// Skill 技能类型
type Skill = {
  name: string;
  description: string;
  input_schema: Record<string, any>;
  handler: (args: any) => Promise<string>;
};

// MCP 基础类型
type MCPRequest = {
  method: string;
  params: Record<string, any>;
};
type MCPResponse = {
  result?: any;
  error?: string;
};

// SubAgent 子任务类型
type SubTask = {
  id: string;
  prompt: string;
  cwd: string;
};

// ====================== 1. 终端流式打印工具 ======================
class StreamPrinter {
  private buffer = "";
  constructor() {
    readline.cursorTo(process.stdout, 0);
  }

  printChunk(text: string) {
    this.buffer += text;
    process.stdout.write(text);
  }

  newLine() {
    process.stdout.write("\n");
    this.buffer = "";
  }

  clearLine() {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  }
}
const streamPrinter = new StreamPrinter();

// ====================== 2. 终端用户输入（持久 readline，避免 close 后进程退出） ======================
let userInputRl: readline.Interface | null = null;

function getUserInputRl(): readline.Interface {
  if (!userInputRl) {
    userInputRl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }
  return userInputRl;
}

function promptUser(question: string): Promise<string> {
  return new Promise((resolve) => {
    getUserInputRl().question(question, (ans) => resolve(ans.trim()));
  });
}

function closeUserInput(): void {
  if (userInputRl) {
    userInputRl.close();
    userInputRl = null;
  }
}

async function confirmOperation(cmd: string): Promise<boolean> {
  console.log(`\n⚠️  敏感操作确认：${cmd}`);
  const ans = await promptUser("是否执行？(y/N) ");
  const lower = ans.toLowerCase();
  return lower === "y" || lower === "yes";
}

// ====================== 3. 分层上下文自动压缩 ======================
async function compressHistory(messages: Message[]): Promise<Message[]> {
  // 保留系统初始prompt + 最新10轮对话，压缩中间历史
  if (messages.length <= 12) return messages;

  const keepHead = messages.slice(0, 2);
  const recent = messages.slice(-10);
  const needCompress = messages.slice(2, -10);

  // 无中间内容无需压缩
  if (needCompress.length === 0) return messages;

  // 调用模型摘要压缩历史操作
  const summaryRes = await client.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "user",
        content: `精简压缩以下Agent操作历史，保留核心操作、关键结果、错误信息、文件变更，删除冗余日志：\n${JSON.stringify(needCompress, null, 2)}`,
      },
    ],
    max_tokens: 2000,
  });

  const summary = summaryRes!.choices[0]!.message!.content || "无历史操作";
  return [
    ...keepHead,
    { role: "user", content: `【历史操作压缩摘要】${summary}` },
    ...recent,
  ];
}

// 简易token估算
function estimateTokenCount(text: string): number {
  return Math.floor(text.length / 4);
}

// 自动检测阈值并触发压缩
async function autoCompress(messages: Message[]): Promise<Message[]> {
  const totalText = messages.map((m) => m.content).join("");
  if (estimateTokenCount(totalText) > MAX_HISTORY_TOKENS) {
    console.log("\n🔧 上下文超阈值，自动压缩历史会话...");
    return await compressHistory(messages);
  }
  return messages;
}

// ====================== 4. Skill 技能注册体系 ======================
const skills: Skill[] = [];

// 注册技能
function registerSkill(skill: Skill) {
  skills.push(skill);
}

// 初始化内置核心技能（对标Claude Code 大工具集）
function initBuiltinSkills() {
  // 读取文件
  registerSkill({
    name: "read_file",
    description: "读取项目内文件内容，支持局部读取",
    input_schema: {
      type: "object",
      properties: { filePath: { type: "string" } },
      required: ["filePath"],
    },
    handler: async (args) => {
      const fullPath = path.resolve(WORK_DIR, args.filePath);
      try {
        return await fs.readFile(fullPath, "utf-8");
      } catch (e: any) {
        return `❌ 读取失败：${e.message}`;
      }
    },
  });

  // 删除文件（阻塞等待用户确认）
  registerSkill({
    name: "delete_file",
    description: "删除项目内文件，执行前必须在终端等待用户确认",
    input_schema: {
      type: "object",
      properties: { filePath: { type: "string" } },
      required: ["filePath"],
    },
    handler: async (args) => {
      const fullPath = path.resolve(WORK_DIR, args.filePath);
      try {
        await fs.access(fullPath);
      } catch {
        return `❌ 文件不存在：${args.filePath}`;
      }
      const ok = await confirmOperation(`删除文件 ${args.filePath}`);
      if (!ok) return `❌ 用户取消删除：${args.filePath}`;
      await fs.unlink(fullPath);
      return `✅ 已删除：${args.filePath}`;
    },
  });

  // 写入文件
  registerSkill({
    name: "write_file",
    description: "新建/覆盖项目文件",
    input_schema: {
      type: "object",
      properties: { filePath: { type: "string" }, content: { type: "string" } },
      required: ["filePath", "content"],
    },
    handler: async (args) => {
      const fullPath = path.resolve(WORK_DIR, args.filePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, args.content, "utf-8");
      return `✅ 文件写入成功：${args.filePath}`;
    },
  });

  // Bash命令执行（带权限校验）
  registerSkill({
    name: "bash",
    description: "执行终端命令、运行脚本、安装依赖、编译项目、git操作",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
    handler: async (args) => {
      const cmd = args.command.trim();
      // 拦截高危指令
      if (BAN_CMD.some((b) => cmd.includes(b)))
        return `❌ 禁止高危命令：${cmd}`;
      // 敏感指令弹窗确认
      if (NEED_CONFIRM_CMD.some((s) => cmd.includes(s))) {
        const ok = await confirmOperation(cmd);
        if (!ok) return `❌ 用户取消操作：${cmd}`;
      }
      try {
        const res = execSync(cmd, {
          cwd: WORK_DIR,
          encoding: "utf-8",
          stdio: "pipe",
        });
        return res || "命令执行成功，无输出";
      } catch (e: any) {
        return `❌ 命令执行失败：${e.message}`;
      }
    },
  });

  // 文件搜索
  registerSkill({
    name: "grep_search",
    description: "项目内关键词搜索代码",
    input_schema: {
      type: "object",
      properties: { keyword: { type: "string" } },
      required: ["keyword"],
    },
    handler: async (args) => {
      try {
        return execSync(
          `grep -r "${args.keyword}" --exclude-dir=node_modules`,
          { cwd: WORK_DIR, encoding: "utf-8" },
        );
      } catch (e) {
        return "未搜索到匹配内容";
      }
    },
  });
}

// ====================== 5. SubAgent 子智能体（主从架构） ======================
async function runSubAgent(task: SubTask): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(
      "npx",
      ["ts-node", __filename, task.prompt, "subtask"],
      {
        cwd: task.cwd,
        stdio: "pipe",
      },
    );

    let output = "";
    child.stdout.on("data", (data) => {
      const chunk = data.toString();
      streamPrinter.printChunk(chunk);
      output += chunk;
    });

    child.stderr.on("data", (data) => {
      output += `子任务错误：${data.toString()}`;
    });

    child.on("close", () => {
      resolve(`【子任务${task.id}完成】\n${output}`);
    });
  });
}

// 批量并行子任务
async function runSubAgentBatch(tasks: SubTask[]): Promise<string[]> {
  return Promise.all(tasks.map((t) => runSubAgent(t)));
}

// ====================== 6. MCP 协议基座（可对接外部工具） ======================
const mcpHandlers: Record<string, (params: any) => Promise<MCPResponse>> = {};

// 注册MCP方法
function registerMCPMethod(
  method: string,
  handler: (params: any) => Promise<MCPResponse>,
) {
  mcpHandlers[method] = handler;
}

// 初始化内置MCP能力
function initMCP() {
  // MCP：获取项目结构
  registerMCPMethod("project.listDir", async (params) => {
    const dir = params.dir || WORK_DIR;
    const list = await fs.readdir(dir);
    return { result: list };
  });

  // MCP：获取系统信息
  registerMCPMethod("system.info", async () => {
    return {
      result: {
        cwd: WORK_DIR,
        nodeVersion: process.version,
        platform: process.platform,
      },
    };
  });
}

// 处理MCP请求
async function handleMCP(req: MCPRequest): Promise<MCPResponse> {
  const handler = mcpHandlers[req.method];
  if (!handler) return { error: `未知MCP方法：${req.method}` };
  return await handler(req.params);
}

export type AgentLoopOptions = {
  isSubTask?: boolean;
  /** 交互模式：模型无 tool call 时等待终端输入再继续，而非直接退出 */
  interactive?: boolean;
};

// ====================== 核心Agent主循环 ======================
export async function agentLoop(
  userPrompt: string,
  options: AgentLoopOptions = {},
) {
  const { isSubTask = false, interactive = !isSubTask } = options;
  initBuiltinSkills();
  initMCP();

  try {
  const messages: Message[] = [
    {
      role: "user",
      content: `你是复刻版Claude Code智能体，严格使用提供的skill工具完成开发任务。
工作目录：${WORK_DIR}
规则：
1. 复杂任务自动拆分，调用子Agent并行处理
2. 删除文件必须调用 delete_file 技能（会阻塞终端等待用户 y/yes 确认），禁止仅用文字询问确认
3. 敏感 bash 命令（rm/mv/chmod 等）会触发终端确认，未确认前不要假定已执行
4. 任务未完成时持续调用工具，不要主动结束
5. 全部完成后输出结构化总结
用户需求：${userPrompt}`,
    },
  ];

  while (true) {
    // 自动上下文压缩
    const compressedMsgs = await autoCompress(messages);

    const toolDefs = skills.map((s) => ({
      type: "function" as const,
      function: { name: s.name, description: s.description, parameters: s.input_schema },
    }));

    // 单次流式调用，同时收集文本、reasoning_content 和 tool_calls
    const stream = await client.chat.completions.create({
      model: MODEL,
      messages: compressedMsgs.map(toAPIMessage),
      tools: toolDefs,
      max_tokens: 384000, // DeepSeek V4-Flash 最大单次输出上限
      stream: true,
    });

    let fullContent = "";
    let reasoningContent = "";
    let finishReason = "";
    const tcMap: Record<number, { id: string; type: "function"; function: { name: string; arguments: string } }> = {};

    streamPrinter.clearLine();
    console.log("\n🤖 Agent 思考中...");

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta as any;
      const fr = chunk.choices[0]?.finish_reason;
      if (fr) finishReason = fr;

      if (delta?.reasoning_content) reasoningContent += delta.reasoning_content;

      if (delta?.content) {
        fullContent += delta.content;
        streamPrinter.printChunk(delta.content);
      }

      // 拼接 tool_calls 增量
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx: number = tc.index ?? 0;
          if (!tcMap[idx]) tcMap[idx] = { id: "", type: "function", function: { name: "", arguments: "" } };
          if (tc.id) tcMap[idx].id = tc.id;
          if (tc.function?.name) tcMap[idx].function.name += tc.function.name;
          if (tc.function?.arguments) tcMap[idx].function.arguments += tc.function.arguments;
        }
      }
    }
    streamPrinter.newLine();

    if (finishReason === "length") {
      console.warn("\n⚠️  输出因达到 max_tokens 上限被截断，tool call 参数可能不完整");
    }

    const collectedToolCalls = Object.values(tcMap);

    // 将 assistant 消息推入上下文
    const assistantMsg: Message = {
      role: "assistant",
      content: fullContent || null,
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      ...(collectedToolCalls.length ? { tool_calls: collectedToolCalls } : {}),
    };
    messages.push(assistantMsg);

    // 无工具调用：交互模式下等待用户输入再继续，否则结束
    if (!collectedToolCalls.length) {
      if (interactive && process.stdin.isTTY) {
        const userReply = await promptUser("\n👤 你的回复（直接回车结束任务）: ");
        if (!userReply) {
          console.log("\n✅ 任务全部完成！");
          return;
        }
        messages.push({ role: "user", content: userReply });
        continue;
      }
      console.log("\n✅ 任务全部完成！最终总结：");
      if (fullContent) console.log(fullContent);
      return;
    }

    // 执行所有工具调用
    for (const tc of collectedToolCalls) {
      const skillName = tc.function.name;
      let skillArgs: any;
      try {
        skillArgs = JSON.parse(tc.function.arguments);
      } catch {
        console.error(`\n❌ tool call 参数 JSON 解析失败（可能被截断）：${tc.function.arguments}`);
        continue;
      }
      console.log(`\n🔧 调用技能：${skillName}`);

      // 匹配对应Skill执行
      const skill = skills.find((s) => s.name === skillName);
      let toolResult = "";
      if (skill) {
        toolResult = await skill.handler(skillArgs);
      } else {
        toolResult = `未知技能：${skillName}`;
      }

      // 回填上下文，继续循环
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: `【${skillName} 执行结果】\n${toolResult}`,
      });
    }
  }
  } finally {
    closeUserInput();
  }
}
