import fs from "fs/promises";
import path from "path";
import OpenAI from "openai";
import { registerSkill } from "./skills";

// ====================== 常量 ======================
const MEMORY_DIR = path.join(process.cwd(), ".memory");
const MEMORY_INDEX = path.join(MEMORY_DIR, "MEMORY.md");
const MAX_INDEX_LINES = 200;
const MAX_INDEX_BYTES = 25 * 1024; // 25KB
const STALE_MS = 24 * 60 * 60 * 1000; // 1 天

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

type MemoryMeta = {
  name: string;
  description: string;
  type: MemoryType;
  date: string;
  file: string;
};

// ====================== 工具函数 ======================
function getClient() {
  return new OpenAI({
    baseURL: process.env.BASE_URL!,
    apiKey: process.env.DEEPSEEK_API_KEY!,
  });
}

/** 解析文件前 30 行的 YAML frontmatter */
function parseFrontmatter(content: string): Partial<MemoryMeta> {
  const lines = content.split("\n").slice(0, 30);
  const start = lines.findIndex((l) => l.trim() === "---");
  const end = lines.findIndex((l, i) => i > start && l.trim() === "---");
  if (start === -1 || end === -1) return {};
  const meta: Record<string, string> = {};
  for (const line of lines.slice(start + 1, end)) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
  }
  return meta as Partial<MemoryMeta>;
}

/** 扫描所有记忆文件，只读前 30 行提取元信息 */
async function scanMemoryFiles(): Promise<MemoryMeta[]> {
  try {
    await fs.access(MEMORY_DIR);
  } catch {
    return [];
  }
  const files = (await fs.readdir(MEMORY_DIR)).filter(
    (f) => f.endsWith(".md") && f !== "MEMORY.md",
  );
  const result: MemoryMeta[] = [];
  for (const file of files) {
    const raw = await fs.readFile(path.join(MEMORY_DIR, file), "utf-8");
    const meta = parseFrontmatter(raw);
    if (meta.name && meta.type && meta.description) {
      result.push({ ...(meta as MemoryMeta), file });
    }
  }
  return result;
}

/** 重建 MEMORY.md 索引，强制双重限制 */
async function rebuildIndex(metas: MemoryMeta[]) {
  const sorted = [...metas].sort((a, b) => b.date.localeCompare(a.date));
  const lines = sorted.map(
    (m) => `- [${m.type}] ${m.file} (${m.date}): ${m.description}`,
  );
  // 同时检查行数和字节数
  while (lines.length > 0) {
    const content = lines.join("\n") + "\n";
    const bytes = new TextEncoder().encode(content).length;
    if (lines.length <= MAX_INDEX_LINES && bytes <= MAX_INDEX_BYTES) {
      await fs.writeFile(MEMORY_INDEX, content, "utf-8");
      return;
    }
    lines.pop();
  }
  await fs.writeFile(MEMORY_INDEX, "", "utf-8");
}

// ====================== 对外 API ======================

/** 加载 MEMORY.md 索引内容（始终注入 system prompt） */
export async function loadMemoryIndex(): Promise<string> {
  try {
    return await fs.readFile(MEMORY_INDEX, "utf-8");
  } catch {
    return "";
  }
}

/**
 * 并行预取：用小模型从索引中选出最相关的记忆，加载完整内容。
 * 设计为与第一次 LLM API 调用并行启动。
 */
export async function recallMemories(query: string): Promise<string> {
  const metas = await scanMemoryFiles();
  if (metas.length === 0) return "";

  const now = Date.now();
  const manifest = metas
    .map((m) => {
      const stale =
        now - new Date(m.date).getTime() > STALE_MS ? " ⚠️ 可能已过时" : "";
      return `- [${m.type}] ${m.file} (${m.date})${stale}: ${m.description}`;
    })
    .join("\n");

  // 用配置的模型做记忆选择（廉价侧查询，max_tokens 极短）
  const client = getClient();
  const model = process.env.MODEL!;
  let selectedFiles: string[] = [];
  try {
    const res = await client.chat.completions.create({
      model,
      messages: [
        {
          role: "user",
          content: `你是记忆选择器。从以下列表中选出最多 5 条与用户问题最相关的记忆，只返回 JSON 数组格式的文件名列表，不要其他内容。\n用户问题：${query}\n\n可用记忆：\n${manifest}`,
        },
      ],
      max_tokens: 256,
    });
    const text = res.choices[0]?.message?.content ?? "[]";
    const match = text.match(/\[[\s\S]*?\]/);
    selectedFiles = match ? (JSON.parse(match[0]) as string[]) : [];
  } catch {
    return "";
  }

  // 加载选中记忆的完整内容
  const contents: string[] = [];
  for (const file of selectedFiles.slice(0, 5)) {
    try {
      const content = await fs.readFile(path.join(MEMORY_DIR, file), "utf-8");
      contents.push(content);
    } catch {}
  }
  return contents.join("\n\n---\n\n");
}

/** 保存一条新记忆，自动重建索引 */
export async function saveMemory(
  name: string,
  type: MemoryType,
  description: string,
  content: string,
): Promise<string> {
  await fs.mkdir(MEMORY_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const slug = name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fa5-]/g, "");
  const file = `${type}_${slug}.md`;
  await fs.writeFile(
    path.join(MEMORY_DIR, file),
    `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\ndate: ${date}\n---\n\n${content}`,
    "utf-8",
  );
  const metas = await scanMemoryFiles();
  await rebuildIndex(metas);
  return `✅ 记忆已保存：${file}`;
}

/** 删除一条记忆，自动重建索引 */
export async function deleteMemory(filename: string): Promise<string> {
  try {
    await fs.unlink(path.join(MEMORY_DIR, filename));
    const metas = await scanMemoryFiles();
    await rebuildIndex(metas);
    return `✅ 记忆已删除：${filename}`;
  } catch (e: any) {
    return `❌ 删除失败：${e.message}`;
  }
}

// ====================== Skill 注册 ======================
export function registerMemorySkills() {
  registerSkill({
    name: "save_memory",
    description:
      "将重要信息持久化到长期记忆。只存用户偏好、行为反馈、项目动态、外部指针，不存代码结构或可从代码推导的信息",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "记忆名称（简短可读）" },
        type: {
          type: "string",
          enum: [...MEMORY_TYPES],
          description:
            "user=用户画像 | feedback=行为反馈 | project=项目动态 | reference=外部指针",
        },
        description: {
          type: "string",
          description: "一句话摘要，用于后续检索匹配",
        },
        content: {
          type: "string",
          description:
            "记忆正文。feedback 类型必须包含：规则本身、Why（原因）、How to apply（应用方式）",
        },
      },
      required: ["name", "type", "description", "content"],
    },
    handler: async (args) =>
      saveMemory(args.name, args.type, args.description, args.content),
  });

  registerSkill({
    name: "delete_memory",
    description: "删除一条不再有效的长期记忆",
    input_schema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "记忆文件名，如 feedback_xxx.md" },
      },
      required: ["filename"],
    },
    handler: async (args) => deleteMemory(args.filename),
  });
}
