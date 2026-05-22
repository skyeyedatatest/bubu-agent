# Coding Agent 代码阅读 & 编辑能力接入方案

> 基于当前 agent 架构（agent.ts / skills.ts / sub-agent.ts）的落地实施计划

---

## 一、现状分析

| 模块           | 现有能力                         | 缺口                   |
| -------------- | -------------------------------- | ---------------------- |
| `skills.ts`    | bash / grep_search / delete_file | 无精准读写文件片段能力 |
| `sub-agent.ts` | 并行子任务派发                   | 无                     |
| `memory.ts`    | 持久化记忆                       | 无法持久化符号索引     |
| `agent.ts`     | 主/子双模式 Agent 循环           | 无                     |

**核心缺口：**

1. 没有「精准读取文件第 N-M 行」的 skill
2. 没有「精准编辑文件片段」的 skill（只能全量 bash 写入）
3. 没有符号索引系统（grep_search 是全文扫描，不是索引）
4. 没有 AST 解析能力

---

## 二、目标能力

| 能力           | Skill 名称           | 优先级 |
| -------------- | -------------------- | ------ |
| 读取文件片段   | `read_file_fragment` | P0     |
| 写入/创建文件  | `write_file`         | P0     |
| 精准行级编辑   | `edit_file_lines`    | P0     |
| 列出项目文件树 | `list_project_files` | P0     |
| 构建符号索引   | `build_symbol_index` | P1     |
| 符号检索       | `search_symbol`      | P1     |
| AST 语义分析   | `parse_ast`          | P2     |
| 调用链追溯     | `find_references`    | P2     |

---

## 三、文件结构

```
skills/
  code-reader.ts    # read_file_fragment + list_project_files
  code-writer.ts    # write_file + edit_file_lines
  symbol-index.ts   # build_symbol_index + search_symbol
  ast-parser.ts     # parse_ast + find_references（依赖 tree-sitter）

src/
  code-index.ts     # 符号索引核心模块（持久化到 .code-index/ 目录）
```

---

## 四、各 Skill 详细设计

### P0 阶段：基础读写能力

#### `read_file_fragment`

```
输入：{ filePath, startLine, endLine, context?: number }
逻辑：读取 [startLine-context, endLine+context] 行，默认 context=10
输出：带行号的代码片段字符串
```

#### `list_project_files`

```
输入：{ dir?, extensions?, excludeDirs? }
逻辑：
  - 默认排除：node_modules / dist / build / .git / .cache
  - 按语言分组输出
  - 返回相对路径 + 行数 + 文件大小
输出：结构化文件树字符串
```

#### `write_file`

```
输入：{ filePath, content, createDirs?: boolean }
逻辑：
  - 写入前检查是否已存在，存在则触发 confirmOperation 确认
  - 自动创建父目录（createDirs=true 时）
输出：写入结果 + 行数统计
```

#### `edit_file_lines`

```
输入：{ filePath, startLine, endLine, newContent }
逻辑：
  1. 读取完整文件
  2. 替换 [startLine, endLine] 行为 newContent
  3. 写回文件
  4. 返回变更前后的 diff 预览
注意：不直接用 bash sed，避免转义地狱
输出：变更摘要 + unified diff 片段
```

### P1 阶段：符号索引能力

#### 符号索引数据结构（持久化到 `.code-index/symbols.json`）

```typescript
type SymbolEntry = {
  name: string;
  type: "function" | "class" | "variable" | "interface" | "route";
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  signature?: string; // 函数签名/类定义
};

type SymbolIndex = {
  version: string;
  builtAt: string;
  symbols: SymbolEntry[];
  fileHashes: Record<string, string>; // 文件路径 -> MD5，用于增量更新
};
```

#### `build_symbol_index`

```
输入：{ dir?, force?: boolean }
逻辑：
  1. 扫描所有代码文件
  2. 逐文件用正则提取符号（不依赖 tree-sitter，P1 先用正则）
     - 函数：/^(export\s+)?(async\s+)?function\s+(\w+)/m
     - 类：/^(export\s+)?(abstract\s+)?class\s+(\w+)/m
     - 箭头函数：/^(export\s+)?const\s+(\w+)\s*=/m
     - 路由：/\.(get|post|put|delete)\(['"`](.*?)['"`]/m
  3. 计算文件 MD5，增量跳过未变更文件
  4. 持久化到 .code-index/symbols.json
输出：索引统计（文件数/符号数/耗时）
```

#### `search_symbol`

```
输入：{ keyword, type?, filePath?, limit?: number }
逻辑：
  1. 加载 .code-index/symbols.json
  2. 模糊匹配 keyword（支持驼峰拆解：loginService 匹配 login）
  3. 返回 top-N 匹配项，包含文件路径 + 行号
输出：匹配结果列表
```

### P2 阶段：AST + 调用链（依赖 tree-sitter）

#### 依赖安装

```bash
npm install tree-sitter tree-sitter-typescript tree-sitter-javascript \
            tree-sitter-python tree-sitter-go tree-sitter-java tree-sitter-rust
```

#### `parse_ast`

```
输入：{ filePath, startLine, endLine, query? }
逻辑：
  - 用 tree-sitter 解析目标片段
  - 返回简化的 AST 摘要（类型 + 参数 + 返回值），不返回完整树
输出：语义摘要
```

#### `find_references`

```
输入：{ symbolName, filePath?, direction: "callers" | "callees" | "both" }
逻辑：
  - callers：搜索所有调用该符号的位置
  - callees：从 AST 提取该函数调用的所有符号
输出：引用列表（文件路径 + 行号 + 上下文行）
```

---

## 五、接入 Agent 架构的方式

### 子 Agent 加载路径

```
agent.ts agentLoop (isSubTask=true)
  → initBuiltinSkills()           # bash / grep_search / delete_file
  → loadExternalSkills("skills/") # 自动加载 code-reader.ts 等
```

不需要改 `agent.ts`，只需将 skill 文件放入 `skills/` 目录。

### 符号索引缓存策略

| 情况               | 策略                                        |
| ------------------ | ------------------------------------------- |
| 首次运行           | 子 Agent 执行 `build_symbol_index` 全量构建 |
| 文件未变更         | 读取缓存，跳过构建                          |
| 文件变更           | MD5 比对后增量更新变更文件的符号            |
| .code-index 不存在 | `search_symbol` 降级到 `grep_search`        |

### 主 Agent 任务拆解示例

用户输入：「帮我给 login 函数加入参校验」

```
主 Agent 拆解 →
  子任务1：search_symbol("login") → 定位文件+行号
  子任务2：read_file_fragment(定位结果) → 读取函数上下文
  子任务3：分析后 edit_file_lines(目标行, 新内容) → 写入修改
```

---

## 六、实施步骤（按优先级）

### Step 1：P0 基础读写（1-2天）

- [ ] 实现 `skills/code-reader.ts`（read_file_fragment + list_project_files）
- [ ] 实现 `skills/code-writer.ts`（write_file + edit_file_lines）
- [ ] 验证子 Agent 能正确加载并调用

### Step 2：P1 符号索引（2-3天）

- [ ] 实现 `src/code-index.ts`（符号提取 + 持久化 + 增量更新）
- [ ] 实现 `skills/symbol-index.ts`（build_symbol_index + search_symbol）
- [ ] 验证：10w 行代码库索引构建 < 5s

### Step 3：P2 AST + 调用链（3-5天）

- [ ] 安装 tree-sitter 及各语言解析器
- [ ] 实现 `skills/ast-parser.ts`（parse_ast + find_references）
- [ ] 语言差异配置表（TS/JS/Python/Go/Java 节点名映射）

---

## 七、关键约束

1. **edit_file_lines 必须有 diff 预览**：编辑前输出变更内容，避免静默破坏代码
2. **write_file 覆盖已有文件需 confirmOperation**：复用 skills.ts 的确认机制
3. **符号索引不进入 LLM 上下文**：只将 search 结果（精简片段）注入上下文
4. **大文件（>1000行）只允许片段读取**：read_file_fragment 强制要求 startLine/endLine
5. **P2 tree-sitter 不影响 P0/P1**：各 skill 文件独立，按需加载
