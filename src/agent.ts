import dotenv from "dotenv";
import { ENV_PATH, WORK_DIR as _WORK_DIR } from "./paths";
dotenv.config({ path: ENV_PATH });
import OpenAI from "openai";
import readline from "readline";
import fs from "fs";
import path from "path";
import { promptWithFileCompletion } from "./input";
import {
  skills,
  initBuiltinSkills,
  loadExternalSkills,
  indexThirdPartySkills,
  registerLoadSkillTool,
  getUnloadedSkills,
} from "./skills";
import { registerSubAgentSkills } from "./sub-agent";
import {
  loadMemoryIndex,
  recallMemories,
  registerMemorySkills,
} from "./memory";
import { initBuiltinMCP, loadExternalMCP } from "./mcp";
import { loadMCPBridge, closeMCPBridge } from "./mcp-bridge";
import {
  initLog,
  logAssistant,
  logToolCall,
  logToolResult,
  logUser,
  logDone,
  logWarn,
} from "./logger";

// ====================== 全局配置 ======================
const client = new OpenAI({
  baseURL: process.env.BASE_URL!,
  apiKey: process.env.DEEPSEEK_API_KEY!,
});
const MODEL = process.env.MODEL!;
const WORK_DIR = _WORK_DIR;
const MAX_HISTORY_TOKENS = 600000; // DeepSeek V4-Flash 上下文 1M，最大输出 384K，输入预算约 616K

// ====================== 类型定义 ======================
type ToolCallItem = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type UserContent = string | ContentPart[];

/** 从 UserContent 提取纯文本（用于日志、记忆召回等需要字符串的场景） */
function contentToText(content: UserContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ");
}

type Message = {
  role: "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_call_id?: string;
  tool_calls?: ToolCallItem[];
  reasoning_content?: string | null; // DeepSeek thinking mode
};

function toAPIMessage(m: Message): any {
  if (m.role === "tool") {
    return {
      role: "tool",
      content: m.content ?? "",
      tool_call_id: m.tool_call_id ?? "",
    };
  }
  if (m.role === "assistant") {
    return {
      role: "assistant",
      content: m.content ?? "",
      ...(m.reasoning_content != null
        ? { reasoning_content: m.reasoning_content }
        : {}),
      ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}),
    };
  }
  return { role: "user", content: m.content ?? "" };
}

// ====================== 0. @文件引用展开（支持多模态图片）======================
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

function getImageMimeType(ext: string): string {
  const map: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
  };
  return map[ext] ?? "image/jpeg";
}

export async function expandFileReferences(input: string): Promise<UserContent> {
  const pattern = /@([^\s@,;:]+)/g;
  const matches = [...input.matchAll(pattern)];
  if (!matches.length) return input;

  const textParts: string[] = [];
  const imageParts: ContentPart[] = [];
  let lastIndex = 0;
  let hasImages = false;

  for (const match of matches) {
    const filePath = match[1] ?? "";
    const startIdx = match.index ?? 0;
    const fullPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(WORK_DIR, filePath);
    const ext = path.extname(filePath).toLowerCase();

    textParts.push(input.slice(lastIndex, startIdx));

    if (IMAGE_EXTS.has(ext)) {
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > MAX_IMAGE_SIZE) {
          console.warn(`⚠️  图片过大（${(stat.size / 1024 / 1024).toFixed(1)}MB > 10MB），已跳过：${filePath}`);
          textParts.push(match[0]);
        } else {
          const data = fs.readFileSync(fullPath);
          const base64 = data.toString("base64");
          const mimeType = getImageMimeType(ext);
          imageParts.push({ type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } });
          hasImages = true;
          console.log(`🖼️  已附加图片：${filePath}（${(stat.size / 1024).toFixed(1)}KB）`);
        }
      } catch {
        textParts.push(match[0]);
      }
    } else {
      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        console.log(`📎 已附加文件：${filePath}`);
        textParts.push(`@${filePath}\n\`\`\`\n${content}\n\`\`\``);
      } catch {
        textParts.push(match[0]); // 文件不存在则保留原文
      }
    }

    lastIndex = startIdx + match[0].length;
  }

  textParts.push(input.slice(lastIndex));

  if (!hasImages) return textParts.join("");

  // 多模态：文字部分 + 图片部分
  const fullText = textParts.join("");
  const parts: ContentPart[] = [];
  if (fullText.trim()) parts.push({ type: "text", text: fullText });
  parts.push(...imageParts);
  return parts;
}

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

// ====================== 2. 终端用户输入 ======================
async function confirmOperation(cmd: string): Promise<boolean> {
  console.log(`\n⚠️  敏感操作确认：${cmd}`);
  const ans = await promptWithFileCompletion("是否执行？(y/N) ");
  const lower = ans.toLowerCase();
  return lower === "" || lower === "y" || lower === "yes";
}

// ====================== 3. 分层上下文自动压缩 ======================
async function compressHistory(messages: Message[]): Promise<Message[]> {
  // 保留系统初始prompt + 最新10轮对话，压缩中间历史
  if (messages.length <= 12) return messages;

  const keepHead = messages.slice(0, 2);

  // 找安全切割点：不能从 tool 消息或 tool_calls 中途开始
  // 向前找最近的 user 消息或无 tool_calls 的 assistant 消息
  let recentStart = messages.length - 10;
  while (recentStart < messages.length) {
    const msg = messages[recentStart] as any;
    if (msg.role === "user") break;
    if (msg.role === "assistant" && !msg.tool_calls?.length) break;
    recentStart++;
  }
  // 如果找不到安全点，保留全部
  if (recentStart >= messages.length) return messages;

  const recent = messages.slice(recentStart);
  const needCompress = messages.slice(2, recentStart);

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

// ====================== 4. Skill 技能注册体系（见 skills.ts）======================

// ====================== 5. SubAgent 子智能体（见 sub-agent.ts）======================

// ====================== 6. MCP 协议基座（见 mcp.ts）======================

export type AgentLoopOptions = {
  isSubTask?: boolean;
  /** 交互模式：模型无 tool call 时等待终端输入再继续，而非直接退出 */
  interactive?: boolean;
  /** 日志标签，用于区分主 Agent 与子任务，默认 "主Agent" */
  logLabel?: string;
  /** 自定义确认函数，子任务通过 IPC 传入以避免 stdin 冲突 */
  confirmFn?: (cmd: string) => Promise<boolean>;
};

// ====================== 核心Agent主循环 ======================
export async function agentLoop(
  userPrompt: UserContent,
  options: AgentLoopOptions = {},
) {
  const { isSubTask = false, interactive = !isSubTask, logLabel, confirmFn } = options;
  const confirm = confirmFn ?? confirmOperation;

  if (isSubTask) {
    // 子 Agent：内置技能立即加载，其余按需加载
    initBuiltinSkills(confirm);
    await loadExternalSkills();      // skills/ 立即加载
    await indexThirdPartySkills();   // .third-party-skills/ 按需加载
    registerLoadSkillTool();
    initBuiltinMCP();
    await loadExternalMCP();
    await loadMCPBridge();
  } else {
    // 主 Agent：只注册派发类工具
    registerSubAgentSkills();
  }
  // 两种 Agent 都可以读写记忆
  registerMemorySkills();

  const userPromptText = contentToText(userPrompt);
  await initLog(userPromptText, logLabel ?? (isSubTask ? "子Agent" : "主Agent"));

  // 并行预取记忆（与后续初始化并行）
  const [memoryIndex, recallPromise] = [
    await loadMemoryIndex(),
    recallMemories(userPromptText),
  ];

  const memorySection = (index: string, recalled: string) => {
    const parts: string[] = [];
    if (index) parts.push(`## 记忆索引\n${index}`);
    if (recalled) parts.push(`## 相关记忆\n${recalled}`);
    return parts.length ? `\n\n${parts.join("\n\n")}` : "";
  };

  // 第一次 LLM 调用前 await 记忆召回结果
  const recalled = await recallPromise;

  const unloadedSkills = getUnloadedSkills();
  const skillsSection =
    unloadedSkills.length > 0
      ? `\n\n## 可按需加载的技能\n${unloadedSkills.map((s) => `- **${s.name}**: ${s.description}`).join("\n")}\n需要时调用 load_skill 加载后即可使用。`
      : "";

  const systemInstructions = isSubTask
    ? `你是执行型子Agent，工作目录：${WORK_DIR}
规则：
1. 严格使用提供的工具完成任务，不要规划或拆分，直接执行
2. 删除文件必须调用 delete_file（会等待用户确认）
3. 敏感 bash 命令（rm/mv/chmod 等）会触发终端确认，未确认前不要假定已执行
4. 任务未完成时持续调用工具，不要主动结束
5. 完成后输出执行结果摘要
6. 读文件用 read_file_fragment，修改文件局部用 edit_file_lines，写整个文件用 write_file，列目录用 list_directory${memorySection(memoryIndex, recalled)}${skillsSection}
子任务内容：`
    : `你是规划型主Agent，工作目录：${WORK_DIR}
规则：
1. 分析用户需求，将任务拆解为若干独立子任务
2. 通过 run_subtasks 并行派发给子Agent执行，每个子任务描述必须完整、自包含
3. 汇总所有子任务结果，向用户输出结构化总结
4. 不要自己执行具体操作，所有执行都交给子Agent完成
5. 发现值得记住的用户偏好或行为反馈时，调用 save_memory 保存${memorySection(memoryIndex, recalled)}
用户需求：`;

  // 构建初始消息内容（纯文本或多模态）
  const initialContent: string | ContentPart[] =
    typeof userPrompt === "string"
      ? systemInstructions + userPrompt
      : [{ type: "text", text: systemInstructions }, ...userPrompt];

  try {
    const messages: Message[] = [
      { role: "user", content: initialContent },
    ];

    while (true) {
      // 自动上下文压缩
      const compressedMsgs = await autoCompress(messages);

      const toolDefs = skills.map((s) => ({
        type: "function" as const,
        function: {
          name: s.name,
          description: s.description,
          parameters: s.input_schema,
        },
      }));

      // 单次流式调用，503/429 自动重试（指数退避，最多 5 次）
      let stream: Awaited<ReturnType<typeof client.chat.completions.create>>;
      for (let attempt = 1; ; attempt++) {
        try {
          stream = await client.chat.completions.create({
            model: MODEL,
            messages: compressedMsgs.map(toAPIMessage),
            tools: toolDefs,
            max_tokens: 384000,
            stream: true,
          });
          break;
        } catch (e: any) {
          const retryable = e?.status === 503 || e?.status === 429;
          if (!retryable || attempt >= 5) throw e;
          const wait = Math.min(2 ** attempt * 1000, 30000);
          const msg = `API ${e.status}，${wait / 1000}s 后重试（${attempt}/5）...`;
          console.warn(`\n⚠️  ${msg}`);
          await logWarn(msg);
          await new Promise((r) => setTimeout(r, wait));
        }
      }

      let fullContent = "";
      let reasoningContent = "";
      let finishReason = "";
      const tcMap: Record<
        number,
        {
          id: string;
          type: "function";
          function: { name: string; arguments: string };
        }
      > = {};

      streamPrinter.clearLine();
      console.log("\n🤖 Agent 思考中...");

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta as any;
        const fr = chunk.choices[0]?.finish_reason;
        if (fr) finishReason = fr;

        if (delta?.reasoning_content)
          reasoningContent += delta.reasoning_content;

        if (delta?.content) {
          fullContent += delta.content;
          streamPrinter.printChunk(delta.content);
        }

        // 拼接 tool_calls 增量
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx: number = tc.index ?? 0;
            if (!tcMap[idx])
              tcMap[idx] = {
                id: "",
                type: "function",
                function: { name: "", arguments: "" },
              };
            if (tc.id) tcMap[idx].id = tc.id;
            if (tc.function?.name) tcMap[idx].function.name += tc.function.name;
            if (tc.function?.arguments)
              tcMap[idx].function.arguments += tc.function.arguments;
          }
        }
      }
      streamPrinter.newLine();

      if (finishReason === "length") {
        const msg =
          "输出因达到 max_tokens 上限被截断，tool call 参数可能不完整";
        console.warn(`\n⚠️  ${msg}`);
        await logWarn(msg);
      }

      const collectedToolCalls = Object.values(tcMap);

      await logAssistant(fullContent, reasoningContent || undefined);

      // 将 assistant 消息推入上下文
      const assistantMsg: Message = {
        role: "assistant",
        content: fullContent || null,
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        ...(collectedToolCalls.length
          ? { tool_calls: collectedToolCalls }
          : {}),
      };
      messages.push(assistantMsg);

      // 无工具调用：交互模式下等待用户输入再继续，否则结束
      if (!collectedToolCalls.length) {
        if (interactive && process.stdin.isTTY) {
          console.log("\n👤 你的回复（直接回车结束任务）");
          const userReply = await promptWithFileCompletion("> ");
          if (!userReply) {
            console.log("\n✅ 任务全部完成！");
            await logDone();
            return;
          }
          const expandedReply = await expandFileReferences(userReply);
          await logUser(contentToText(expandedReply));
          messages.push({ role: "user", content: expandedReply });
          continue;
        }
        console.log("\n✅ 任务全部完成！最终总结：");
        if (fullContent) console.log(fullContent);
        await logDone(fullContent || undefined);
        return;
      }

      // 执行所有工具调用
      for (const tc of collectedToolCalls) {
        const skillName = tc.function.name;
        let skillArgs: any;
        try {
          skillArgs = JSON.parse(tc.function.arguments);
        } catch {
          console.error(
            `\n❌ tool call 参数 JSON 解析失败（可能被截断）：${tc.function.arguments}`,
          );
          continue;
        }
        console.log(`\n🔧 调用技能：${skillName}`);
        await logToolCall(skillName, skillArgs);

        // 匹配对应Skill执行
        const skill = skills.find((s) => s.name === skillName);
        let toolResult = "";
        if (skill) {
          toolResult = await skill.handler(skillArgs);
        } else {
          toolResult = `未知技能：${skillName}`;
        }

        await logToolResult(skillName, toolResult);

        // 回填上下文，继续循环
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: `【${skillName} 执行结果】\n${toolResult}`,
        });
      }
    }
  } finally {
    await closeMCPBridge();
  }
}
