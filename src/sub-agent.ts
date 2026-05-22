import path from "path";
import { fileURLToPath } from "url";
import { spawn, type ChildProcess } from "child_process";
import { registerSkill } from "./skills";
import { enqueueConfirm } from "./confirm-queue";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(__dirname, "sub-agent-runner.ts");

// ====================== 类型定义 ======================
type SubTask = {
  id: string;
  prompt: string;
  /** 子任务工作目录，默认继承父进程 */
  cwd?: string;
};

// ====================== 子 Agent 执行 ======================
function runSubAgent(task: SubTask): Promise<string> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn("tsx", [RUNNER, task.prompt, task.id], {
      cwd: task.cwd ?? process.cwd(),
      // stdin ignore：确认走 IPC，stdout/stderr 管道捕获输出，ipc 通道传确认消息
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: process.env,
    });

    // 收到子进程的确认请求，排入串行队列后回复
    child.on("message", async (msg: unknown) => {
      const m = msg as { type: string; id: string; cmd: string };
      if (m?.type === "confirm_request") {
        const answer = await enqueueConfirm(m.cmd);
        child.send({ type: "confirm_reply", id: m.id, answer });
      }
    });

    let output = "";
    const prefix = `[子任务 ${task.id}] `;

    // 按行加前缀，避免流式 token 每个词都打一次标签
    function prefixLines(chunk: string, tag: string): string {
      return chunk
        .split("\n")
        .map((line, i, arr) =>
          // 最后一个空片段（换行结尾）不加前缀
          i === arr.length - 1 && line === "" ? "" : tag + line,
        )
        .join("\n");
    }

    let stdoutBuf = "";
    child.stdout!.on("data", (data: Buffer) => {
      stdoutBuf += data.toString();
      output += data.toString();
      // 每次有完整行时才输出
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop()!; // 保留未完成的行
      if (lines.length) process.stdout.write(prefixLines(lines.join("\n") + "\n", prefix));
    });

    child.stderr!.on("data", (data: Buffer) => {
      const chunk = data.toString();
      output += chunk;
      process.stderr.write(prefixLines(chunk, `[子任务 ${task.id} ERR] `));
    });

    child.on("close", (code) => {
      if (stdoutBuf) process.stdout.write(prefix + stdoutBuf + "\n");
      resolve(`【子任务 ${task.id} 完成 exit=${code}】\n${output}`);
    });

    child.on("error", (err) => {
      resolve(`【子任务 ${task.id} 启动失败】${err.message}`);
    });
  });
}

// ====================== Skill 注册 ======================
export function registerSubAgentSkills() {
  // 单个子任务
  registerSkill({
    name: "run_subtask",
    description:
      "将一个独立子任务派发给子 Agent 执行，子 Agent 拥有完整工具集，适合可独立完成的子问题",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "任务标识，便于追踪" },
        prompt: { type: "string", description: "子任务的完整描述" },
      },
      required: ["id", "prompt"],
    },
    handler: async (args: { id: string; prompt: string }) => {
      console.log(`\n🚀 派发子任务 [${args.id}]：${args.prompt}`);
      return await runSubAgent({ id: args.id, prompt: args.prompt });
    },
  });

  // 批量并行子任务
  registerSkill({
    name: "run_subtasks",
    description:
      "并行派发多个独立子任务，所有子 Agent 同时运行，适合可拆分的复杂任务",
    input_schema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          description: "子任务列表",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              prompt: { type: "string" },
            },
            required: ["id", "prompt"],
          },
        },
      },
      required: ["tasks"],
    },
    handler: async (args: { tasks: SubTask[] }) => {
      console.log(`\n🚀 并行派发 ${args.tasks.length} 个子任务...`);
      const results = await Promise.all(args.tasks.map((t) => runSubAgent(t)));
      return results.join("\n\n");
    },
  });
}
