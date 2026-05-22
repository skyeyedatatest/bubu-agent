import path from "path";
import type { Skill } from "../src/skills.js";
import {
  buildIndex,
  loadIndex,
  searchSymbols,
  type SymbolType,
} from "../src/code-index.js";

const WORK_DIR = process.cwd();

// ====================== build_symbol_index ======================
const buildSymbolIndex: Skill = {
  name: "build_symbol_index",
  description:
    "扫描项目代码文件，构建全局符号索引（函数/类/接口/路由等）。" +
    "支持增量更新（仅重扫有变更的文件）。" +
    "首次使用或代码大量变更后调用；后续直接用 search_symbol 检索。",
  input_schema: {
    type: "object",
    properties: {
      dir: {
        type: "string",
        description: "扫描目录，默认为当前工作目录",
      },
      force: {
        type: "boolean",
        description: "是否强制全量重建（忽略缓存），默认 false",
      },
    },
  },
  handler: async (args: { dir?: string; force?: boolean }) => {
    const dir = args.dir ? path.resolve(WORK_DIR, args.dir) : WORK_DIR;
    const result = await buildIndex(dir, args.force ?? false);
    return [
      `✅ 符号索引构建完成`,
      `   扫描文件：${result.fileCount} 个`,
      `   更新文件：${result.updatedFiles} 个`,
      `   符号总数：${result.symbolCount} 个`,
      `   耗时：${result.ms}ms`,
      `   缓存位置：.code-index/symbols.json`,
    ].join("\n");
  },
};

// ====================== search_symbol ======================
const searchSymbol: Skill = {
  name: "search_symbol",
  description:
    "从符号索引中搜索函数/类/接口/路由，返回文件路径和行号。" +
    "支持驼峰模糊匹配（如 loginSvc 能匹配 LoginService）。" +
    "若索引不存在，自动降级到 grep_search。",
  input_schema: {
    type: "object",
    properties: {
      keyword: { type: "string", description: "搜索关键词，支持驼峰/下划线" },
      type: {
        type: "string",
        enum: ["function", "class", "variable", "interface", "route"],
        description: "限定符号类型（可选）",
      },
      filePath: {
        type: "string",
        description: "限定搜索范围到特定文件路径（可选，模糊匹配）",
      },
      limit: {
        type: "number",
        description: "返回最多 N 条结果，默认 20",
      },
    },
    required: ["keyword"],
  },
  handler: async (args: {
    keyword: string;
    type?: SymbolType;
    filePath?: string;
    limit?: number;
  }) => {
    const index = await loadIndex();

    // 索引不存在 → 降级到 grep
    if (!index) {
      const { execSync } = await import("child_process");
      try {
        const res = execSync(
          `grep -rn "${args.keyword}" --include="*.ts" --include="*.js" --include="*.py" --include="*.go" --include="*.java" --exclude-dir=node_modules`,
          { cwd: WORK_DIR, encoding: "utf-8" },
        );
        return `⚠️  符号索引不存在（先运行 build_symbol_index），降级 grep 结果：\n${res}`;
      } catch {
        return `⚠️  符号索引不存在，且 grep 未找到匹配：${args.keyword}`;
      }
    }

    const hits = searchSymbols(index, args.keyword, {
      type: args.type,
      filePath: args.filePath,
      limit: args.limit,
    });

    if (hits.length === 0) {
      return `未找到匹配 "${args.keyword}" 的符号。\n提示：可尝试 grep_search 做全文搜索。`;
    }

    const lines: string[] = [
      `找到 ${hits.length} 个匹配 "${args.keyword}" 的符号：\n`,
    ];
    for (const h of hits) {
      lines.push(
        `[${h.type}] ${h.name}`,
        `  文件：${h.filePath}  第 ${h.startLine}-${h.endLine} 行`,
        `  ${h.signature ?? ""}`,
        "",
      );
    }
    return lines.join("\n");
  },
};

export default [buildSymbolIndex, searchSymbol];
