import fs from "fs/promises";
import path from "path";
import { execSync } from "child_process";

const WORK_DIR = process.cwd();

// ====================== 类型定义 ======================
export type Skill = {
  name: string;
  description: string;
  input_schema: Record<string, any>;
  handler: (args: any) => Promise<string>;
};

// ====================== 技能注册表 ======================
export const skills: Skill[] = [];

export function registerSkill(skill: Skill) {
  if (skills.find((s) => s.name === skill.name)) {
    console.warn(`⚠️  Skill "${skill.name}" 已注册，跳过重复加载`);
    return;
  }
  skills.push(skill);
}

// ====================== 加载第三方 Skills ======================
/**
 * 从指定目录动态加载第三方 skill 文件。
 *
 * 每个 skill 文件需 export default 以下两种格式之一：
 *   - 单个 Skill 对象：{ name, description, input_schema, handler }
 *   - Skill 数组：[{ name, ... }, ...]
 *
 * 示例文件 skills/hello.ts：
 *   import type { Skill } from "../skills";
 *   const skill: Skill = {
 *     name: "hello",
 *     description: "打招呼",
 *     input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
 *     handler: async (args) => `Hello, ${args.name}!`,
 *   };
 *   export default skill;
 */
export async function loadExternalSkills(
  skillsDir: string = path.join(process.cwd(), "skills"),
) {
  try {
    await fs.access(skillsDir);
  } catch {
    return; // skills 目录不存在，静默跳过
  }

  const files = (await fs.readdir(skillsDir)).filter(
    (f) => f.endsWith(".ts") || f.endsWith(".js"),
  );

  if (files.length === 0) return;

  console.log(`\n📦 发现 ${files.length} 个第三方 skill 文件，开始加载...`);

  for (const file of files) {
    const filePath = path.join(skillsDir, file);
    try {
      // ts-node 环境下可直接 import .ts 文件
      const mod = await import(filePath);
      const exported: Skill | Skill[] | undefined =
        mod.default ?? mod.skill ?? mod.skills;

      if (Array.isArray(exported)) {
        let count = 0;
        for (const s of exported) {
          if (isValidSkill(s)) {
            registerSkill(s);
            count++;
          } else {
            console.warn(`⚠️  ${file} 中存在无效 skill 对象，已跳过`);
          }
        }
        if (count > 0)
          console.log(`  ✅ ${file} → 加载 ${count} 个技能`);
      } else if (isValidSkill(exported)) {
        registerSkill(exported!);
        console.log(`  ✅ ${file} → 加载技能：${exported!.name}`);
      } else {
        console.warn(`  ⚠️  ${file} 未导出合法 skill，已跳过`);
      }
    } catch (e: any) {
      console.error(`  ❌ 加载失败：${file} — ${e.message}`);
    }
  }
}

function isValidSkill(s: any): s is Skill {
  return (
    s != null &&
    typeof s.name === "string" &&
    typeof s.description === "string" &&
    typeof s.handler === "function"
  );
}

// ====================== 内置核心技能 ======================
export function initBuiltinSkills(
  confirmOperation: (cmd: string) => Promise<boolean>,
) {
  const BAN_CMD = ["rm -rf /", "sudo ", "chmod 777", "> /etc", "mkfs ", "dd if="];
  const NEED_CONFIRM_CMD = ["rm ", "mv ", "chmod", "npm uninstall", "git reset"];

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

  // Bash 命令执行（带权限校验）
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
      if (BAN_CMD.some((b) => cmd.includes(b)))
        return `❌ 禁止高危命令：${cmd}`;
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
      } catch {
        return "未搜索到匹配内容";
      }
    },
  });
}
