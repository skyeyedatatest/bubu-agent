import fs from "fs/promises";
import path from "path";
import { execSync } from "child_process";
import { logToolCall } from "./logger";
import { WORK_DIR, SKILLS_DIR, THIRD_PARTY_DIR } from "./paths";

// ====================== 类型定义 ======================
export type Skill = {
  name: string;
  description: string;
  input_schema: Record<string, any>;
  handler: (args: any) => Promise<string>;
};

// ====================== 技能注册表 ======================
export const skills: Skill[] = [];

// ====================== 全局 confirm 函数（供外部 skill 使用）======================
let _globalConfirm: ((cmd: string) => Promise<boolean>) | null = null;

export function setGlobalConfirm(fn: (cmd: string) => Promise<boolean>): void {
  _globalConfirm = fn;
}

export async function globalConfirm(cmd: string): Promise<boolean> {
  if (_globalConfirm) return _globalConfirm(cmd);
  return true; // 无 confirm fn 时自动通过（子 Agent 初始化前不应调用）
}

export function registerSkill(skill: Skill) {
  if (skills.find((s) => s.name === skill.name)) {
    console.warn(`⚠️  Skill "${skill.name}" 已注册，跳过重复加载`);
    return;
  }
  skills.push(skill);
}

// ====================== 技能索引（按需加载）======================

type SkillIndexEntry = {
  description: string;
  load: () => Promise<void>;
};

const _skillIndex = new Map<string, SkillIndexEntry>();

/** 返回已索引但尚未加载的技能列表 */
export function getUnloadedSkills(): Array<{ name: string; description: string }> {
  return Array.from(_skillIndex.entries()).map(([name, e]) => ({
    name,
    description: e.description,
  }));
}

/** 注册 load_skill 元工具，LLM 调用后动态激活指定技能 */
export function registerLoadSkillTool() {
  registerSkill({
    name: "load_skill",
    description:
      "按需加载并激活一个技能。加载后该技能立即可用，可直接调用。",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "要加载的技能名称" },
      },
      required: ["name"],
    },
    handler: async (args: { name: string }) => {
      const entry = _skillIndex.get(args.name);
      if (!entry) {
        const available = Array.from(_skillIndex.keys()).join(", ");
        return available
          ? `❌ 未找到技能 "${args.name}"。索引中可用：${available}`
          : `❌ 未找到技能 "${args.name}"，索引为空`;
      }
      await entry.load();
      return `✅ 技能 "${args.name}" 已加载，可直接调用`;
    },
  });
}

// ====================== 立即加载 skills/（用户自定义技能）======================

/**
 * 扫描 skills/ 目录，立即注册所有技能。
 * 用户自定义技能专为当前项目编写，默认全部可用。
 */
export async function loadExternalSkills(
  skillsDir: string = SKILLS_DIR,
) {
  try {
    await fs.access(skillsDir);
  } catch {
    return;
  }

  const files = (await fs.readdir(skillsDir)).filter(
    (f) => f.endsWith(".ts") || f.endsWith(".js"),
  );

  for (const file of files) {
    const filePath = path.join(skillsDir, file);
    try {
      const mod = await import(filePath);
      const exported: Skill | Skill[] | undefined =
        mod.default ?? mod.skill ?? mod.skills;

      const list: Skill[] = Array.isArray(exported)
        ? exported.filter(isValidSkill)
        : isValidSkill(exported)
          ? [exported!]
          : [];

      for (const s of list) registerSkill(s);
    } catch (e: any) {
      console.error(`  ❌ 加载失败：${file} — ${e.message}`);
    }
  }
}

/** 别名，供需要按需加载行为的场景使用 */
export const indexExternalSkills = loadExternalSkills;

function isValidSkill(s: any): s is Skill {
  return (
    s != null &&
    typeof s.name === "string" &&
    typeof s.description === "string" &&
    typeof s.handler === "function"
  );
}

// ====================== 索引 .third-party-skills（按需加载）======================

/**
 * 扫描 .third-party-skills/ 目录，将 SKILL.md 包存入索引，不立即注册。
 */
export async function indexThirdPartySkills(
  baseDir: string = THIRD_PARTY_DIR,
) {
  try {
    await fs.access(baseDir);
  } catch {
    return;
  }

  const entries = await fs.readdir(baseDir, { withFileTypes: true });
  const pkgDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  for (const dir of pkgDirs) {
    const skillMdPath = path.join(baseDir, dir, "SKILL.md");
    try {
      const raw = await fs.readFile(skillMdPath, "utf-8");
      const { name, description, body } = parseSkillMd(raw);
      if (!name || !description) continue;

      const skillName = sanitizeSkillName(name);
      if (_skillIndex.has(skillName) || skills.find((s) => s.name === skillName))
        continue;

      _skillIndex.set(skillName, {
        description,
        load: async () => {
          registerSkill({
            name: skillName,
            description,
            input_schema: {
              type: "object",
              properties: {
                query: { type: "string", description: "具体要执行的操作或查询" },
              },
              required: [],
            },
            handler: async (_args) => body,
          });
          _skillIndex.delete(skillName);
        },
      });
    } catch {
      // 无 SKILL.md，跳过
    }
  }
}

/** 保留旧名称兼容调用 */
export const loadThirdPartySkills = indexThirdPartySkills;

/** 解析 SKILL.md frontmatter（--- ... --- 格式） */
function parseSkillMd(raw: string): {
  name: string;
  description: string;
  body: string;
} {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) return { name: "", description: "", body: raw };

  const fm = fmMatch[1] ?? "";
  const body = (fmMatch[2] ?? "").trim();

  const get = (key: string) => {
    const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m ? (m[1] ?? "").trim().replace(/^["']|["']$/g, "") : "";
  };

  return { name: get("name"), description: get("description"), body };
}

/** skill name 只允许字母、数字、下划线、连字符 */
function sanitizeSkillName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
}

// ====================== 内置核心技能 ======================
export function initBuiltinSkills(
  confirmOperation: (cmd: string) => Promise<boolean>,
) {
  setGlobalConfirm(confirmOperation);
  const BAN_CMD = [
    "rm -rf /",
    "sudo ",
    "chmod 777",
    "> /etc",
    "mkfs ",
    "dd if=",
  ];
  const NEED_CONFIRM_CMD = [
    "rm ",
    "mv ",
    "chmod",
    "npm uninstall",
    "git reset",
  ];

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
