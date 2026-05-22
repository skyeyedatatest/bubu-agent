import fs from "fs/promises";
import path from "path";
import type { Skill } from "../src/skills.js";

const WORK_DIR = process.cwd();

// tree-sitter 语言包映射
const LANG_PKG: Record<string, string> = {
  ".ts": "tree-sitter-typescript",
  ".tsx": "tree-sitter-typescript",
  ".js": "tree-sitter-javascript",
  ".jsx": "tree-sitter-javascript",
  ".py": "tree-sitter-python",
  ".go": "tree-sitter-go",
  ".java": "tree-sitter-java",
  ".rs": "tree-sitter-rust",
};

// tree-sitter 各语言中「函数」「类」「方法」的节点类型名
const NODE_TYPES: Record<string, { func: string[]; class: string[]; method: string[] }> = {
  typescript: {
    func: ["function_declaration", "arrow_function", "function_expression"],
    class: ["class_declaration"],
    method: ["method_definition"],
  },
  javascript: {
    func: ["function_declaration", "arrow_function", "function_expression"],
    class: ["class_declaration"],
    method: ["method_definition"],
  },
  python: {
    func: ["function_definition"],
    class: ["class_definition"],
    method: ["function_definition"], // Python 方法也是 function_definition
  },
  go: {
    func: ["function_declaration"],
    class: ["type_declaration"],
    method: ["method_declaration"],
  },
  java: {
    func: ["method_declaration"],
    class: ["class_declaration"],
    method: ["method_declaration"],
  },
  rust: {
    func: ["function_item"],
    class: ["struct_item"],
    method: ["function_item"],
  },
};

// 检查 tree-sitter 是否已安装
async function checkTreeSitter(): Promise<boolean> {
  try {
    await import("tree-sitter");
    return true;
  } catch {
    return false;
  }
}

const INSTALL_MSG = [
  "❌ tree-sitter 未安装，请先执行：",
  "",
  "npm install tree-sitter tree-sitter-typescript tree-sitter-javascript \\",
  "           tree-sitter-python tree-sitter-go tree-sitter-java tree-sitter-rust",
].join("\n");

// ====================== parse_ast ======================
const parseAst: Skill = {
  name: "parse_ast",
  description:
    "用 tree-sitter 解析代码文件的指定行范围，返回简化的 AST 语义摘要" +
    "（函数签名、参数列表、返回类型、内部调用等）。" +
    "需要已安装 tree-sitter 及对应语言包。",
  input_schema: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "文件路径（相对工作目录或绝对路径）" },
      startLine: { type: "number", description: "起始行号（1-based），默认 1" },
      endLine: { type: "number", description: "结束行号（1-based），默认解析整个文件" },
    },
    required: ["filePath"],
  },
  handler: async (args: { filePath: string; startLine?: number; endLine?: number }) => {
    if (!(await checkTreeSitter())) return INSTALL_MSG;

    const fullPath = path.resolve(WORK_DIR, args.filePath);
    const ext = path.extname(args.filePath);
    const langPkg = LANG_PKG[ext];
    if (!langPkg) return `❌ 不支持的文件类型：${ext}`;

    let content: string;
    try {
      content = await fs.readFile(fullPath, "utf-8");
    } catch (e: unknown) {
      return `❌ 无法读取文件：${(e as Error).message}`;
    }

    try {
      const Parser = (await import("tree-sitter")).default;
      const LangMod = await import(langPkg);
      const parser = new Parser();

      // tree-sitter-typescript 导出 typescript / tsx
      const isTs = ext === ".ts" || ext === ".tsx";
      const lang = isTs
        ? (LangMod.default?.typescript ?? LangMod.typescript ?? LangMod.default)
        : (LangMod.default ?? LangMod);

      parser.setLanguage(lang);
      const tree = parser.parse(content);

      // 提取指定行范围内的节点摘要
      const allLines = content.split("\n");
      const reqStart = (args.startLine ?? 1) - 1; // 0-based
      const reqEnd = (args.endLine ?? allLines.length) - 1;

      const langName = Object.keys(NODE_TYPES).find((k) =>
        langPkg.includes(k),
      ) ?? "javascript";
      const nodeTypes = NODE_TYPES[langName] ?? NODE_TYPES.javascript!;
      const interestingTypes = new Set([
        ...nodeTypes.func,
        ...nodeTypes.class,
        ...nodeTypes.method,
      ]);

      const summaries: string[] = [];

      function visit(node: any): void {
        const { startPosition, endPosition } = node;
        if (
          startPosition.row > reqEnd ||
          endPosition.row < reqStart
        ) return;

        if (interestingTypes.has(node.type)) {
          const lineNo = startPosition.row + 1;
          const srcLine = (allLines[startPosition.row] ?? "").trim().slice(0, 120);
          summaries.push(`[${node.type}] 第${lineNo}行: ${srcLine}`);
        }

        for (let i = 0; i < node.childCount; i++) {
          visit(node.child(i));
        }
      }

      visit(tree.rootNode);

      if (summaries.length === 0) {
        return `在第 ${args.startLine ?? 1}-${args.endLine ?? allLines.length} 行范围内未找到函数/类定义`;
      }
      return summaries.join("\n");
    } catch (e: unknown) {
      return `❌ AST 解析失败：${(e as Error).message}`;
    }
  },
};

// ====================== find_references ======================
const findReferences: Skill = {
  name: "find_references",
  description:
    "追溯代码调用链：\n" +
    "- callers：哪些地方调用了指定符号\n" +
    "- callees：指定函数内部调用了哪些符号\n" +
    "- both：同时查找两个方向\n" +
    "需要已安装 tree-sitter 及对应语言包。",
  input_schema: {
    type: "object",
    properties: {
      symbolName: { type: "string", description: "要追溯的函数/类名" },
      filePath: {
        type: "string",
        description: "限定搜索范围到指定文件（可选）",
      },
      direction: {
        type: "string",
        enum: ["callers", "callees", "both"],
        description: "追溯方向：callers=谁调用了它，callees=它调用了谁，both=两个方向",
      },
    },
    required: ["symbolName", "direction"],
  },
  handler: async (args: {
    symbolName: string;
    filePath?: string;
    direction: "callers" | "callees" | "both";
  }) => {
    if (!(await checkTreeSitter())) return INSTALL_MSG;

    // callers：全项目 grep 调用点（快速可靠）
    const { execSync } = await import("child_process");
    const results: string[] = [];

    if (args.direction === "callers" || args.direction === "both") {
      const scope = args.filePath
        ? path.resolve(WORK_DIR, args.filePath)
        : WORK_DIR;
      try {
        const grep = execSync(
          `grep -rn "\\b${args.symbolName}\\b" --include="*.ts" --include="*.js" --include="*.py" --include="*.go" --include="*.java" --exclude-dir=node_modules`,
          { cwd: typeof scope === "string" ? (args.filePath ? WORK_DIR : scope) : WORK_DIR, encoding: "utf-8" },
        );
        const callerLines = grep
          .split("\n")
          .filter((l) => l.includes(args.symbolName) && !l.includes(`function ${args.symbolName}`) && !l.includes(`def ${args.symbolName}`));
        results.push(`=== callers（调用方）: ${callerLines.length} 处 ===`);
        results.push(...callerLines.slice(0, 30));
        if (callerLines.length > 30) results.push(`... 还有 ${callerLines.length - 30} 处`);
      } catch {
        results.push("=== callers: 未找到调用点 ===");
      }
    }

    if (args.direction === "callees" || args.direction === "both") {
      if (!args.filePath) {
        results.push("\n=== callees：需要指定 filePath 才能分析内部调用 ===");
      } else {
        const fullPath = path.resolve(WORK_DIR, args.filePath);
        const ext = path.extname(args.filePath);
        const langPkg = LANG_PKG[ext];

        if (!langPkg) {
          results.push(`\n=== callees：不支持的文件类型 ${ext} ===`);
        } else {
          try {
            const content = await fs.readFile(fullPath, "utf-8");
            const Parser = (await import("tree-sitter")).default;
            const LangMod = await import(langPkg);
            const parser = new Parser();
            const isTs = ext === ".ts" || ext === ".tsx";
            const lang = isTs
              ? (LangMod.default?.typescript ?? LangMod.typescript ?? LangMod.default)
              : (LangMod.default ?? LangMod);
            parser.setLanguage(lang);
            const tree = parser.parse(content);

            // 找到目标函数节点，再收集其内部 call_expression
            const callees = new Set<string>();
            let inTarget = false;
            let targetDepth = 0;

            function visitCallees(node: any, depth: number): void {
              if (
                (node.type === "function_declaration" ||
                  node.type === "method_definition" ||
                  node.type === "function_definition") &&
                node.childForFieldName?.("name")?.text === args.symbolName
              ) {
                inTarget = true;
                targetDepth = depth;
              }

              if (inTarget) {
                if (node.type === "call_expression" || node.type === "call") {
                  const callee =
                    node.childForFieldName?.("function")?.text ??
                    node.child(0)?.text ??
                    "";
                  if (callee) callees.add(callee.slice(0, 60));
                }
              }

              for (let i = 0; i < node.childCount; i++) {
                visitCallees(node.child(i), depth + 1);
              }

              if (inTarget && depth <= targetDepth) inTarget = false;
            }

            visitCallees(tree.rootNode, 0);

            results.push(`\n=== callees（${args.symbolName} 调用了）: ${callees.size} 个 ===`);
            results.push(...[...callees]);
          } catch (e: unknown) {
            results.push(`\n=== callees 分析失败：${(e as Error).message} ===`);
          }
        }
      }
    }

    return results.join("\n") || "未找到任何调用关系";
  },
};

export default [parseAst, findReferences];
