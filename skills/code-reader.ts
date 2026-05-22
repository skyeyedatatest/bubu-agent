import fs from "fs/promises";
import path from "path";
import type { Skill } from "../src/skills.js";

const WORK_DIR = process.cwd();
const EXCLUDED_DIRS = new Set([
  "node_modules", "dist", "build", ".git", ".cache", ".code-index",
]);
const DEFAULT_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".java", ".rs", ".c", ".cpp", ".cs",
  ".vue", ".svelte", ".rb", ".php", ".swift", ".kt",
]);

// ====================== read_file_fragment ======================
const readFileFragment: Skill = {
  name: "read_file_fragment",
  description:
    "读取文件指定行范围的代码片段（带行号）。大文件（>1000行）必须指定 startLine/endLine。" +
    "默认前后各扩展 10 行上下文。",
  input_schema: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "文件路径（相对工作目录或绝对路径）" },
      startLine: { type: "number", description: "起始行号（1-based）" },
      endLine: {
        type: "number",
        description: "结束行号（1-based），-1 表示读到文件末尾",
      },
      context: { type: "number", description: "前后扩展行数，默认 10" },
    },
    required: ["filePath"],
  },
  handler: async (args: {
    filePath: string;
    startLine?: number;
    endLine?: number;
    context?: number;
  }) => {
    const fullPath = path.resolve(WORK_DIR, args.filePath);
    let content: string;
    try {
      content = await fs.readFile(fullPath, "utf-8");
    } catch (e: unknown) {
      return `❌ 无法读取文件：${(e as Error).message}`;
    }

    const lines = content.split("\n");
    const total = lines.length;

    // 未指定行范围 → 检查文件大小
    if (args.startLine == null && args.endLine == null) {
      if (total > 1000) {
        return (
          `⚠️  文件共 ${total} 行，超过 1000 行限制。\n` +
          `请指定 startLine 和 endLine 参数读取片段。\n` +
          `提示：可先用 search_symbol 或 grep_search 定位目标行号。`
        );
      }
      return lines
        .map((l, i) => `${String(i + 1).padStart(5)} | ${l}`)
        .join("\n");
    }

    const ctx = args.context ?? 10;
    const reqStart = args.startLine ?? 1;
    const reqEnd = args.endLine === -1 ? total : (args.endLine ?? total);

    const sliceStart = Math.max(0, reqStart - 1 - ctx);
    const sliceEnd = Math.min(total - 1, reqEnd - 1 + ctx);

    return lines
      .slice(sliceStart, sliceEnd + 1)
      .map((l, i) => {
        const lineNo = sliceStart + i + 1;
        const marker =
          lineNo >= reqStart && lineNo <= reqEnd ? ">" : " ";
        return `${marker}${String(lineNo).padStart(5)} | ${l}`;
      })
      .join("\n");
  },
};

// ====================== list_project_files ======================
type FileInfo = {
  relPath: string;
  lines: number;
  sizeKb: string;
  ext: string;
};

const listProjectFiles: Skill = {
  name: "list_project_files",
  description:
    "列出项目目录内的代码文件，按语言分组，显示路径/行数/大小。" +
    "默认排除 node_modules/dist/build/.git 等目录。",
  input_schema: {
    type: "object",
    properties: {
      dir: {
        type: "string",
        description: "扫描目录，默认为当前工作目录",
      },
      extensions: {
        type: "array",
        items: { type: "string" },
        description: '过滤扩展名，如 [".ts", ".js"]，默认扫描全部代码文件',
      },
      excludeDirs: {
        type: "array",
        items: { type: "string" },
        description: "额外排除的目录名列表",
      },
    },
  },
  handler: async (args: {
    dir?: string;
    extensions?: string[];
    excludeDirs?: string[];
  }) => {
    const rootDir = args.dir ? path.resolve(WORK_DIR, args.dir) : WORK_DIR;
    const extraExclude = new Set<string>(args.excludeDirs ?? []);
    const filterExts =
      args.extensions && args.extensions.length > 0
        ? new Set<string>(args.extensions)
        : DEFAULT_EXTS;

    const results: FileInfo[] = [];

    async function walk(dir: string): Promise<void> {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const fullPath = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!EXCLUDED_DIRS.has(e.name) && !extraExclude.has(e.name)) {
            await walk(fullPath);
          }
        } else if (e.isFile()) {
          const ext = path.extname(e.name);
          if (filterExts.has(ext)) {
            const stat = await fs.stat(fullPath);
            const raw = await fs.readFile(fullPath, "utf-8");
            results.push({
              relPath: path.relative(WORK_DIR, fullPath),
              lines: raw.split("\n").length,
              sizeKb: (stat.size / 1024).toFixed(1),
              ext,
            });
          }
        }
      }
    }

    await walk(rootDir);

    if (results.length === 0) return "未找到任何代码文件";

    // Group by ext
    const grouped: Record<string, FileInfo[]> = {};
    for (const f of results) {
      (grouped[f.ext] ??= []).push(f);
    }

    const out: string[] = [`共 ${results.length} 个文件\n`];
    for (const [ext, files] of Object.entries(grouped).sort()) {
      out.push(`[${ext}] ${files.length} 个文件`);
      for (const f of files.sort((a, b) => a.relPath.localeCompare(b.relPath))) {
        out.push(`  ${f.relPath}  (${f.lines}行, ${f.sizeKb}KB)`);
      }
    }
    return out.join("\n");
  },
};

// ====================== list_directory ======================
const listDirectory: Skill = {
  name: "list_directory",
  description:
    "列出指定目录的文件和子目录（非递归，一层）。显示类型、大小、修改时间。",
  input_schema: {
    type: "object",
    properties: {
      dirPath: {
        type: "string",
        description: "目录路径（相对工作目录或绝对路径），默认为工作目录",
      },
    },
  },
  handler: async (args: { dirPath?: string }) => {
    const target = args.dirPath
      ? path.resolve(WORK_DIR, args.dirPath)
      : WORK_DIR;

    let entries;
    try {
      entries = await fs.readdir(target, { withFileTypes: true });
    } catch (e: unknown) {
      return `❌ 无法读取目录：${(e as Error).message}`;
    }

    if (entries.length === 0) return "（空目录）";

    const rows = await Promise.all(
      entries
        .sort((a, b) => {
          // 目录优先，再按名称排序
          if (a.isDirectory() !== b.isDirectory())
            return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .map(async (e) => {
          const fullPath = path.join(target, e.name);
          let extra = "";
          try {
            const stat = await fs.stat(fullPath);
            if (e.isDirectory()) {
              extra = "dir";
            } else {
              extra = `${(stat.size / 1024).toFixed(1)}KB  ${stat.mtime.toISOString().slice(0, 10)}`;
            }
          } catch {
            extra = "?";
          }
          const prefix = e.isDirectory() ? "📁" : "📄";
          return `${prefix} ${e.name.padEnd(36)} ${extra}`;
        }),
    );

    const relLabel = args.dirPath ?? ".";
    return `${relLabel}/\n${rows.join("\n")}`;
  },
};

export default [readFileFragment, listProjectFiles, listDirectory];
