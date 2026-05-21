import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { registerSkill } from "./skills";

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
    const child = spawn("tsx", [RUNNER, task.prompt], {
      cwd: task.cwd ?? process.cwd(),
      stdio: "pipe",
      env: process.env,
    });

    let output = "";

    child.stdout.on("data", (data: Buffer) => {
      const chunk = data.toString();
      process.stdout.write(`  [子任务 ${task.id}] ${chunk}`);
      output += chunk;
    });

    child.stderr.on("data", (data: Buffer) => {
      const chunk = data.toString();
      process.stderr.write(`  [子任务 ${task.id} ERR] ${chunk}`);
      output += chunk;
    });

    child.on("close", (code) => {
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
