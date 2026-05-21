import fs from "fs/promises";
import path from "path";

let logFile: string | null = null;

function enabled(): boolean {
  return process.env.AGENT_LOG === "true";
}

/** 初始化日志文件，文件名含时间戳，写入会话头 */
export async function initLog(userPrompt: string) {
  if (!enabled()) return;

  const dir = path.join(process.cwd(), "logs");
  await fs.mkdir(dir, { recursive: true });

  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  logFile = path.join(dir, `agent-${ts}.log`);

  await write(`${"=".repeat(60)}
会话开始：${new Date().toLocaleString()}
用户需求：${userPrompt}
${"=".repeat(60)}\n`);
}

/** 记录 LLM 回复 */
export async function logAssistant(content: string, reasoning?: string) {
  if (!enabled() || !logFile) return;
  const parts: string[] = [`\n[🤖 Assistant]`];
  if (reasoning) parts.push(`<thinking>\n${reasoning}\n</thinking>`);
  if (content) parts.push(content);
  await write(parts.join("\n") + "\n");
}

/** 记录工具调用 */
export async function logToolCall(name: string, args: unknown) {
  if (!enabled() || !logFile) return;
  await write(`\n[🔧 Tool Call] ${name}\n${JSON.stringify(args, null, 2)}\n`);
}

/** 记录工具结果 */
export async function logToolResult(name: string, result: string) {
  if (!enabled() || !logFile) return;
  await write(`[📤 Tool Result] ${name}\n${result}\n`);
}

/** 记录用户追加输入 */
export async function logUser(content: string) {
  if (!enabled() || !logFile) return;
  await write(`\n[👤 User]\n${content}\n`);
}

/** 记录会话结束 */
export async function logDone(summary?: string) {
  if (!enabled() || !logFile) return;
  await write(`\n${"=".repeat(60)}\n会话结束：${new Date().toLocaleString()}\n`);
  if (summary) await write(`最终总结：${summary}\n`);
  await write(`${"=".repeat(60)}\n`);
  console.log(`\n📝 运行日志已保存：${logFile}`);
}

/** 记录错误或警告 */
export async function logWarn(msg: string) {
  if (!enabled() || !logFile) return;
  await write(`[⚠️  ${new Date().toLocaleTimeString()}] ${msg}\n`);
}

async function write(text: string) {
  if (!logFile) return;
  await fs.appendFile(logFile, text, "utf-8");
}
