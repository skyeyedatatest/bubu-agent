import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { PROJECT_DIR } from "./paths.js";

export const INDEX_DIR = path.join(PROJECT_DIR, ".code-index");
export const SYMBOLS_FILE = path.join(INDEX_DIR, "symbols.json");

const EXCLUDED_DIRS = new Set([
  "node_modules", "dist", "build", ".git", ".cache", ".code-index",
]);

// ====================== 类型定义 ======================
export type SymbolType = "function" | "class" | "variable" | "interface" | "route";

export type SymbolEntry = {
  name: string;
  type: SymbolType;
  filePath: string;   // 相对 WORK_DIR 的路径
  startLine: number;  // 1-based
  endLine: number;    // 1-based
  language: string;
  signature?: string; // 函数签名/类定义行（截断至120字符）
};

type SymbolIndex = {
  version: string;
  builtAt: string;
  symbols: SymbolEntry[];
  fileHashes: Record<string, string>; // relPath → MD5
};

// ====================== 语言映射 ======================
const LANG_MAP: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript",
  ".js": "javascript", ".jsx": "javascript",
  ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".java": "java",
  ".rs": "rust",
  ".rb": "ruby",
  ".php": "php",
  ".cs": "csharp",
  ".cpp": "cpp",
  ".c": "c",
};
const CODE_EXTS = new Set(Object.keys(LANG_MAP));

// ====================== 符号提取规则 ======================
type Rule = {
  pattern: RegExp;
  type: SymbolType;
  nameGroup: number;
};

function getRules(lang: string): Rule[] {
  if (lang === "python") {
    return [
      { pattern: /^class\s+(\w+)/, type: "class", nameGroup: 1 },
      { pattern: /^def\s+(\w+)/, type: "function", nameGroup: 1 },
    ];
  }
  if (lang === "go") {
    return [
      { pattern: /^type\s+(\w+)\s+struct/, type: "class", nameGroup: 1 },
      { pattern: /^type\s+(\w+)\s+interface/, type: "interface", nameGroup: 1 },
      // func (recv Type) MethodName  or  func FuncName
      { pattern: /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/, type: "function", nameGroup: 1 },
    ];
  }
  if (lang === "java") {
    return [
      { pattern: /(?:public|private|protected|)\s*(?:abstract\s+)?class\s+(\w+)/, type: "class", nameGroup: 1 },
      { pattern: /(?:public|private|protected|)\s*interface\s+(\w+)/, type: "interface", nameGroup: 1 },
      { pattern: /(?:public|private|protected|static|\s)+\w+\s+(\w+)\s*\(/, type: "function", nameGroup: 1 },
    ];
  }
  if (lang === "rust") {
    return [
      { pattern: /^(?:pub\s+)?struct\s+(\w+)/, type: "class", nameGroup: 1 },
      { pattern: /^(?:pub\s+)?trait\s+(\w+)/, type: "interface", nameGroup: 1 },
      { pattern: /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/, type: "function", nameGroup: 1 },
    ];
  }
  // Default: JS/TS/C#/C/C++
  return [
    { pattern: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/, type: "class", nameGroup: 1 },
    { pattern: /^(?:export\s+)?interface\s+(\w+)/, type: "interface", nameGroup: 1 },
    { pattern: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)/, type: "function", nameGroup: 1 },
    // const foo = (async) ( ... ) => or const foo = async function
    { pattern: /^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/, type: "function", nameGroup: 1 },
    { pattern: /^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?function/, type: "function", nameGroup: 1 },
  ];
}

// ====================== 结束行查找 ======================
function findEndLine(lines: string[], startIdx: number, lang: string): number {
  const line = lines[startIdx] ?? "";

  if (lang === "python") {
    const startIndent = (line.match(/^(\s*)/) ?? ["", ""])[1]?.length ?? 0;
    for (let i = startIdx + 1; i < lines.length; i++) {
      const l = lines[i] ?? "";
      if (l.trim() === "") continue;
      const indent = (l.match(/^(\s*)/) ?? ["", ""])[1]?.length ?? 0;
      if (indent <= startIndent) return i; // 不包含 i
    }
    return lines.length;
  }

  // 大括号计数法（JS/TS/Go/Java/Rust/C/C#）
  let depth = 0;
  let foundOpen = false;
  const limit = Math.min(startIdx + 300, lines.length);
  for (let i = startIdx; i < limit; i++) {
    const l = lines[i] ?? "";
    for (const ch of l) {
      if (ch === "{") { depth++; foundOpen = true; }
      else if (ch === "}") { depth--; }
    }
    if (foundOpen && depth === 0) return i + 1; // 1-based inclusive end
  }
  return Math.min(startIdx + 100, lines.length);
}

// ====================== 符号提取（单文件）======================
export function extractSymbols(
  content: string,
  filePath: string,
  lang: string,
): SymbolEntry[] {
  const lines = content.split("\n");
  const rules = getRules(lang);
  const symbols: SymbolEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed) continue;

    for (const rule of rules) {
      const m = trimmed.match(rule.pattern);
      if (m) {
        const name = m[rule.nameGroup];
        if (!name) continue;
        const endLine = findEndLine(lines, i, lang);
        symbols.push({
          name,
          type: rule.type,
          filePath,
          startLine: i + 1,
          endLine,
          language: lang,
          signature: trimmed.slice(0, 120),
        });
        break; // 每行只匹配第一条规则
      }
    }

    // 路由检测（框架无关）
    const routeM = trimmed.match(/\.(get|post|put|delete|patch)\s*\(\s*['"`](.*?)['"`]/);
    if (routeM) {
      const method = (routeM[1] ?? "").toUpperCase();
      const routePath = routeM[2] ?? "";
      symbols.push({
        name: `${method} ${routePath}`,
        type: "route",
        filePath,
        startLine: i + 1,
        endLine: i + 1,
        language: lang,
        signature: trimmed.slice(0, 120),
      });
    }
  }

  return symbols;
}

// ====================== 文件扫描 ======================
async function scanFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(d: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!EXCLUDED_DIRS.has(e.name)) await walk(full);
      } else if (e.isFile() && CODE_EXTS.has(path.extname(e.name))) {
        results.push(full);
      }
    }
  }
  await walk(dir);
  return results;
}

function md5(content: string): string {
  return crypto.createHash("md5").update(content).digest("hex");
}

// ====================== 对外 API ======================

export async function loadIndex(): Promise<SymbolIndex | null> {
  try {
    const raw = await fs.readFile(SYMBOLS_FILE, "utf-8");
    return JSON.parse(raw) as SymbolIndex;
  } catch {
    return null;
  }
}

export type BuildResult = {
  fileCount: number;
  updatedFiles: number;
  symbolCount: number;
  ms: number;
};

/** 构建或增量更新符号索引 */
export async function buildIndex(dir: string, force = false): Promise<BuildResult> {
  const t0 = Date.now();
  await fs.mkdir(INDEX_DIR, { recursive: true });

  const existing = force ? null : await loadIndex();
  const fileHashes: Record<string, string> = { ...(existing?.fileHashes ?? {}) };

  // 按文件聚合符号（用于增量保留）
  const symbolsByFile = new Map<string, SymbolEntry[]>();
  for (const s of existing?.symbols ?? []) {
    const arr = symbolsByFile.get(s.filePath) ?? [];
    arr.push(s);
    symbolsByFile.set(s.filePath, arr);
  }

  const files = await scanFiles(dir);
  let updatedFiles = 0;

  for (const file of files) {
    const content = await fs.readFile(file, "utf-8");
    const hash = md5(content);
    const relPath = path.relative(WORK_DIR, file);

    if (!force && fileHashes[relPath] === hash) continue; // 未变更，跳过

    const lang = LANG_MAP[path.extname(file)] ?? "unknown";
    symbolsByFile.set(relPath, extractSymbols(content, relPath, lang));
    fileHashes[relPath] = hash;
    updatedFiles++;
  }

  // 清理已删除文件
  const currentSet = new Set(files.map((f) => path.relative(WORK_DIR, f)));
  for (const key of Object.keys(fileHashes)) {
    if (!currentSet.has(key)) {
      delete fileHashes[key];
      symbolsByFile.delete(key);
    }
  }

  const allSymbols: SymbolEntry[] = [];
  for (const syms of symbolsByFile.values()) allSymbols.push(...syms);

  const index: SymbolIndex = {
    version: "1.0",
    builtAt: new Date().toISOString(),
    symbols: allSymbols,
    fileHashes,
  };

  await fs.writeFile(SYMBOLS_FILE, JSON.stringify(index, null, 2), "utf-8");
  return { fileCount: files.length, updatedFiles, symbolCount: allSymbols.length, ms: Date.now() - t0 };
}

/** 符号搜索（支持驼峰拆解模糊匹配） */
export function searchSymbols(
  index: SymbolIndex,
  keyword: string,
  opts: { type?: SymbolType; filePath?: string; limit?: number },
): SymbolEntry[] {
  const kw = keyword.toLowerCase();
  // 驼峰拆解：loginService → ["login", "service"]
  const parts = keyword
    .replace(/([A-Z])/g, " $1")
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean);

  const scored = index.symbols
    .filter((s) => {
      if (opts.type && s.type !== opts.type) return false;
      if (opts.filePath && !s.filePath.includes(opts.filePath)) return false;
      return true;
    })
    .map((s) => {
      const name = s.name.toLowerCase();
      let score = 0;
      if (name === kw) score = 100;
      else if (name.startsWith(kw)) score = 80;
      else if (name.includes(kw)) score = 60;
      else if (parts.length > 1 && parts.every((p) => name.includes(p))) score = 50;
      else if (parts.some((p) => name.includes(p))) score = 30;
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, opts.limit ?? 20).map((x) => x.s);
}
