import "dotenv/config";
import { agentLoop } from "./agent";

// 子 Agent 入口：由 sub-agent.ts spawn 调用
// argv[2] = 任务 prompt，argv[3] = 任务 id
const prompt = process.argv[2];
const taskId = process.argv[3] ?? "subtask";

if (!prompt) {
  console.error("❌ 缺少任务 prompt");
  process.exit(1);
}

await agentLoop(prompt, { isSubTask: true, logLabel: `子任务-${taskId}` });
