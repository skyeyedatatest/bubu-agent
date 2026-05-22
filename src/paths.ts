import path from "path";
import { createHash } from "crypto";
import { existsSync } from "fs";
import { createRequire } from "module";

/** Agent 包根目录（src/ 的上一级） */
export const AGENT_ROOT = path.dirname(
  path.dirname(new URL(import.meta.url).pathname),
);

/** 当前运行所在的项目目录 */
export const WORK_DIR = process.cwd();

/**
 * 当前项目在 agent 下的专属目录。
 * 用 cwd 路径的 sha256 前 8 位 + 最后一段目录名，兼顾可读性和唯一性。
 *   /Users/foo/projects/my-app  →  my-app-a3f2c1d8
 */
function projectId(): string {
  const hash = createHash("sha256").update(WORK_DIR).digest("hex").slice(0, 8);
  const name = path.basename(WORK_DIR);
  return `${name}-${hash}`;
}

export const PROJECT_DIR = path.join(AGENT_ROOT, "projects", projectId());

// ── 各功能路径 ────────────────────────────────────────────────
export const MEMORY_DIR       = path.join(PROJECT_DIR, ".memory");
export const LOGS_DIR         = path.join(PROJECT_DIR, "logs");
export const SKILLS_DIR       = path.join(AGENT_ROOT, "skills");
export const THIRD_PARTY_DIR  = path.join(AGENT_ROOT, ".third-party-skills");
export const MCP_CONFIG_PATH  = path.join(AGENT_ROOT, "mcp_servers.json");
export const ENV_PATH         = path.join(AGENT_ROOT, ".env");

/** 解析 tsx 可执行方式，供子 Agent spawn 使用（不依赖全局 PATH） */
export function resolveTsxSpawn(): { command: string; args: string[] } {
  const win = process.platform === "win32";
  const localBin = path.join(
    AGENT_ROOT,
    "node_modules",
    ".bin",
    win ? "tsx.cmd" : "tsx",
  );
  if (existsSync(localBin)) {
    return { command: localBin, args: [] };
  }

  const require = createRequire(import.meta.url);
  try {
    const cli = require.resolve("tsx/dist/cli.mjs");
    return { command: process.execPath, args: [cli] };
  } catch {
    return { command: win ? "tsx.cmd" : "tsx", args: [] };
  }
}
