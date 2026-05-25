import fs from "fs";
import path from "path";

const WORK_DIR = process.cwd();
const MAX_SUGGESTIONS = 10;

// ── 文件建议列表 ────────────────────────────────────────────
function getFileSuggestions(prefix: string): string[] {
  let dir: string;
  let filePrefix: string;

  if (prefix.includes("/")) {
    const lastSlash = prefix.lastIndexOf("/");
    dir = prefix.slice(0, lastSlash + 1);
    filePrefix = prefix.slice(lastSlash + 1).toLowerCase();
  } else {
    dir = "";
    filePrefix = prefix.toLowerCase();
  }

  const fullDir = path.join(WORK_DIR, dir || ".");

  try {
    const entries = fs.readdirSync(fullDir, { withFileTypes: true });
    return entries
      .filter(
        (e) =>
          e.name.toLowerCase().startsWith(filePrefix) &&
          !e.name.startsWith("."),
      )
      .map((e) => dir + e.name + (e.isDirectory() ? "/" : ""))
      .slice(0, MAX_SUGGESTIONS);
  } catch {
    return [];
  }
}

/** 终端显示宽度（CJK / emoji 按 2 列估算） */
function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    w +=
      code > 0xff ||
      (code >= 0x1100 && code <= 0xffef) ||
      (code >= 0x1f300 && code <= 0x1ffff)
        ? 2
        : 1;
  }
  return w;
}

// ── 交互式输入（支持 @文件 自动补全） ─────────────────────────
interface Completion {
  suggestions: string[];
  selectedIndex: number;
  atStart: number; // @ 在 inputBuffer 中的位置
}

export function promptWithFileCompletion(question: string): Promise<string> {
  return new Promise((resolve) => {
    // 非 TTY（管道）降级为普通读取
    if (!process.stdin.isTTY) {
      process.stdout.write(question);
      let buf = "";
      const onData = (chunk: Buffer) => {
        buf += chunk.toString();
        if (buf.includes("\n")) {
          process.stdin.removeListener("data", onData);
          resolve(buf.split("\n")[0]?.trim() ?? "");
        }
      };
      process.stdin.resume();
      process.stdin.on("data", onData);
      return;
    }

    const leadingNewlines = question.match(/^\n+/)?.[0] ?? "";
    const promptLine = question.slice(leadingNewlines.length);
    // 提示只输出一次；redraw 仅更新用户输入，避免长中文提示换行后重复堆叠
    if (leadingNewlines) process.stdout.write(leadingNewlines);
    process.stdout.write(promptLine);

    let inputBuffer = "";
    let renderedInputWidth = 0;
    let completion: Completion | null = null;
    let shownLines = 0;
    let renderedInputLines = 1;
    const promptCols = visualWidth(promptLine);

    // 清除已渲染的建议行（光标须在最后一行输入行末尾）
    function clearSuggestions() {
      if (shownLines === 0) return;
      for (let i = 0; i < shownLines; i++) {
        process.stdout.write("\n\x1b[2K");
      }
      process.stdout.write(`\x1b[${shownLines}A`);
      shownLines = 0;
    }

    // 重绘输入区（支持多行）
    function refreshInput() {
      // 移到第一行输入行
      if (renderedInputLines > 1) {
        process.stdout.write(`\x1b[${renderedInputLines - 1}A`);
      }

      const lines = inputBuffer.split("\n");
      for (let i = 0; i < lines.length; i++) {
        process.stdout.write(i === 0 ? `\r\x1b[${promptCols + 1}G\x1b[K` : `\r\x1b[K`);
        process.stdout.write(lines[i] ?? "");
        if (i < lines.length - 1) process.stdout.write("\n");
      }

      // 若行数减少，清除多余的旧行
      if (renderedInputLines > lines.length) {
        for (let i = 0; i < renderedInputLines - lines.length; i++) {
          process.stdout.write("\n\x1b[K");
        }
        process.stdout.write(`\x1b[${renderedInputLines - lines.length}A`);
        const lastLine = lines[lines.length - 1] ?? "";
        const col = lines.length > 1
          ? visualWidth(lastLine) + 1
          : promptCols + visualWidth(lastLine) + 1;
        process.stdout.write(`\r\x1b[${col}G`);
      }

      renderedInputLines = lines.length;
      renderedInputWidth = visualWidth(lines[lines.length - 1] ?? "");
    }

    // 渲染建议行（在输入区下方）
    function renderSuggestions() {
      clearSuggestions();
      if (!completion || completion.suggestions.length === 0) return;

      for (let i = 0; i < completion.suggestions.length; i++) {
        process.stdout.write("\n\x1b[2K");
        if (i === completion.selectedIndex) {
          process.stdout.write(`\x1b[7m  ${completion.suggestions[i]}  \x1b[0m`);
        } else {
          process.stdout.write(`  \x1b[2m${completion.suggestions[i]}\x1b[0m`);
        }
        shownLines++;
      }
      // 回到最后一行输入行末尾
      process.stdout.write(`\x1b[${shownLines}A`);
      const lines = inputBuffer.split("\n");
      const lastLine = lines[lines.length - 1] ?? "";
      const col = lines.length > 1
        ? visualWidth(lastLine) + 1
        : promptCols + visualWidth(lastLine) + 1;
      process.stdout.write(`\r\x1b[${col}G`);
    }

    function redraw() {
      clearSuggestions();
      refreshInput();
      renderSuggestions();
    }

    // 根据 inputBuffer 更新补全状态
    function updateCompletion() {
      const atIdx = inputBuffer.lastIndexOf("@");
      if (atIdx === -1) {
        completion = null;
        return;
      }
      const prefix = inputBuffer.slice(atIdx + 1);
      // @ 后有空格或换行说明路径已结束
      if (prefix.includes(" ") || prefix.includes("\n")) {
        completion = null;
        return;
      }
      const suggestions = getFileSuggestions(prefix);
      if (suggestions.length === 0) {
        completion = null;
        return;
      }
      completion = { suggestions, selectedIndex: 0, atStart: atIdx };
    }

    // Tab 键：选中当前高亮项
    function selectSuggestion() {
      if (!completion || completion.suggestions.length === 0) return;
      const selected = completion.suggestions[completion.selectedIndex] ?? "";
      inputBuffer = inputBuffer.slice(0, completion.atStart + 1) + selected;
      // 若选了目录，继续展示子目录/文件；否则补空格并关闭补全
      if (selected.endsWith("/")) {
        updateCompletion();
      } else {
        inputBuffer += " ";
        completion = null;
      }
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdout.write("\x1b[?2004h"); // 启用 bracketed paste 模式

    let pasting = false;

    function cleanup() {
      process.stdout.write("\x1b[?2004l"); // 禁用 bracketed paste 模式
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }

    const onData = (key: string) => {
      // Enter：有补全列表时先选中，否则提交
      if (key === "\r" || key === "\n") {
        if (completion && completion.suggestions.length > 0) {
          selectSuggestion();
          redraw();
          return;
        }
        clearSuggestions();
        process.stdout.write("\n");
        process.stdin.removeListener("data", onData);
        cleanup();
        resolve(inputBuffer.trim());
        return;
      }

      // Alt+Enter：插入换行（多行输入）
      if (key === "\x1b\r" || key === "\x1b\n") {
        inputBuffer += "\n";
        updateCompletion();
        redraw();
        return;
      }

      // Ctrl+C
      if (key === "\x03") {
        cleanup();
        process.stdout.write("\n");
        process.exit(0);
      }

      // Backspace
      if (key === "\x7f" || key === "\b") {
        if (inputBuffer.length > 0) {
          inputBuffer = inputBuffer.slice(0, -1);
          updateCompletion();
          redraw();
        }
        return;
      }

      // ↑ 上移高亮
      if (key === "\x1b[A") {
        if (completion) {
          completion.selectedIndex = Math.max(0, completion.selectedIndex - 1);
          renderSuggestions();
        }
        return;
      }

      // ↓ 下移高亮
      if (key === "\x1b[B") {
        if (completion) {
          completion.selectedIndex = Math.min(
            completion.suggestions.length - 1,
            completion.selectedIndex + 1,
          );
          renderSuggestions();
        }
        return;
      }

      // Tab：选中补全项
      if (key === "\t") {
        if (completion && completion.suggestions.length > 0) {
          selectSuggestion();
          redraw();
        }
        return;
      }

      // Bracketed paste 开始
      if (key === "\x1b[200~" || key.startsWith("\x1b[200~")) {
        pasting = true;
        let content = key.slice("\x1b[200~".length);
        const endIdx = content.indexOf("\x1b[201~");
        if (endIdx !== -1) {
          content = content.slice(0, endIdx);
          pasting = false;
        }
        inputBuffer += content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        updateCompletion();
        redraw();
        return;
      }

      // Bracketed paste 结束
      if (key === "\x1b[201~") {
        pasting = false;
        return;
      }

      // 粘贴中途收到的数据块
      if (pasting) {
        const endIdx = key.indexOf("\x1b[201~");
        const content = endIdx !== -1 ? key.slice(0, endIdx) : key;
        if (endIdx !== -1) pasting = false;
        inputBuffer += content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        updateCompletion();
        redraw();
        return;
      }

      // Esc：关闭建议
      if (key === "\x1b") {
        completion = null;
        clearSuggestions();
        refreshInput();
        return;
      }

      // 忽略其他 ESC 序列（←→ 等）
      if (key.startsWith("\x1b")) return;

      inputBuffer += key;
      updateCompletion();
      redraw();
    };

    process.stdin.on("data", onData);
  });
}
