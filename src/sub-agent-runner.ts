import dotenv from "dotenv";
import { ENV_PATH } from "./paths";
dotenv.config({ path: ENV_PATH });
import { agentLoop } from "./agent";

// 子 Agent 入口：由 sub-agent.ts spawn 调用
// argv[2] = 任务 prompt，argv[3] = 任务 id
const prompt = process.argv[2];
const taskId = process.argv[3] ?? "subtask";

if (!prompt) {
  console.error("❌ 缺少任务 prompt");
  process.exit(1);
}

// 通过 IPC 向父进程请求确认，避免多子进程争抢 stdin
function confirmViaIPC(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const id = `${Date.now()}-${Math.random()}`;
    process.send!({ type: "confirm_request", id, cmd });
    const handler = (msg: unknown) => {
      const m = msg as { type: string; id: string; answer: boolean };
      if (m?.type === "confirm_reply" && m.id === id) {
        process.off("message", handler);
        resolve(m.answer);
      }
    };
    process.on("message", handler);
  });
}

agentLoop(prompt, {
  isSubTask: true,
  logLabel: `子任务-${taskId}`,
  confirmFn: confirmViaIPC,
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
