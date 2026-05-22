import fs from "fs/promises";
import path from "path";
import type { Skill } from "../src/skills.js";
import { globalConfirm } from "../src/skills.js";
import { buildIndex, SYMBOLS_FILE } from "../src/code-index.js";

const WORK_DIR = process.cwd();

async function tryIncrementalIndex() {
  try {
    await fs.access(SYMBOLS_FILE);
    await buildIndex(WORK_DIR, false);
  } catch {
    // 索引不存在 → 首次全量构建
    try {
      await buildIndex(WORK_DIR, false);
    } catch {
      // 构建失败，静默忽略
    }
  }
}

// ====================== 简易 diff 生成 ======================
function buildDiff(
  oldLines: string[],
  newLines: string[],
  filePath: string,
  startLine: number,
  endLine: number,
): string {
  const out: string[] = [
    `--- a/${filePath}  (第 ${startLine}-${endLine} 行)`,
    `+++ b/${filePath}`,
  ];
  for (const l of oldLines) out.push(`- ${l}`);
  for (const l of newLines) out.push(`+ ${l}`);
  return out.join("\n");
}

// ====================== write_file ======================
const writeFile: Skill = {
  name: "write_file",
  description:
    "写入或创建文件。覆盖已有文件时需要用户确认。" +
    "createDirs=true 时自动创建父目录。",
  input_schema: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "文件路径（相对工作目录或绝对路径）" },
      content: { type: "string", description: "文件完整内容" },
      createDirs: {
        type: "boolean",
        description: "是否自动创建父目录，默认 true",
      },
    },
    required: ["filePath", "content"],
  },
  handler: async (args: {
    filePath: string;
    content: string;
    createDirs?: boolean;
  }) => {
    const fullPath = path.resolve(WORK_DIR, args.filePath);

    let exists = false;
    try {
      await fs.access(fullPath);
      exists = true;
    } catch {
      // 不存在，正常
    }

    if (exists) {
      const ok = await globalConfirm(`覆盖已有文件 ${args.filePath}`);
      if (!ok) return `❌ 用户取消覆盖：${args.filePath}`;
    }

    if (args.createDirs !== false) {
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
    }

    await fs.writeFile(fullPath, args.content, "utf-8");
    await tryIncrementalIndex();
    const lineCount = args.content.split("\n").length;
    return `✅ ${exists ? "覆盖" : "创建"}文件：${args.filePath}（共 ${lineCount} 行）`;
  },
};

// ====================== edit_file_lines ======================
const editFileLines: Skill = {
  name: "edit_file_lines",
  description:
    "【修改文件局部内容时优先使用此工具】按行号范围精准替换文件内容（startLine~endLine，1-based，含两端）。" +
    "比文本匹配替换更可靠，不受重复内容干扰。" +
    "返回 diff 预览。newContent 为空字符串时等同于删除该范围。",
  input_schema: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "文件路径（相对工作目录或绝对路径）" },
      startLine: { type: "number", description: "起始行号（1-based）" },
      endLine: { type: "number", description: "结束行号（1-based）" },
      newContent: {
        type: "string",
        description: "替换后的新内容，可以是多行（用 \\n 分隔），空字符串表示删除",
      },
    },
    required: ["filePath", "startLine", "endLine", "newContent"],
  },
  handler: async (args: {
    filePath: string;
    startLine: number;
    endLine: number;
    newContent: string;
  }) => {
    const fullPath = path.resolve(WORK_DIR, args.filePath);

    let content: string;
    try {
      content = await fs.readFile(fullPath, "utf-8");
    } catch (e: unknown) {
      return `❌ 无法读取文件：${(e as Error).message}`;
    }

    const allLines = content.split("\n");
    const total = allLines.length;

    if (args.startLine < 1 || args.endLine < args.startLine || args.startLine > total) {
      return `❌ 行号无效：startLine=${args.startLine}, endLine=${args.endLine}, 文件共 ${total} 行`;
    }

    const clampEnd = Math.min(args.endLine, total);
    const before = allLines.slice(0, args.startLine - 1);
    const removed = allLines.slice(args.startLine - 1, clampEnd);
    const after = allLines.slice(clampEnd);

    const newLines = args.newContent === "" ? [] : args.newContent.split("\n");
    const result = [...before, ...newLines, ...after];

    const diff = buildDiff(removed, newLines, args.filePath, args.startLine, clampEnd);

    await fs.writeFile(fullPath, result.join("\n"), "utf-8");
    await tryIncrementalIndex();

    const delta = newLines.length - removed.length;
    const deltaStr = delta === 0 ? "行数不变" : delta > 0 ? `+${delta} 行` : `${delta} 行`;
    return [
      `✅ 已编辑：${args.filePath}`,
      `   替换第 ${args.startLine}-${clampEnd} 行（${removed.length} 行 → ${newLines.length} 行，${deltaStr}）`,
      "",
      diff,
    ].join("\n");
  },
};

export default [writeFile, editFileLines];
