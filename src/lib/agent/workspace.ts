export type DeskFile = { path: string; content: string };

export type ToolStep = {
  tool: string;
  detail: string;
  output: string;
};

export const SEED: DeskFile[] = [
  {
    path: "README.md",
    content: `# desk

一个很小的工作区。这里不只有 src/math.ml：还有问候函数和一张待办。

## 怎么跑

（还没写）
`,
  },
  {
    path: "src/math.ml",
    content: "let add x y = x - y\n",
  },
  {
    path: "src/greet.ml",
    content: 'let hello name = "hi " ^ name\n',
  },
  {
    path: "notes/todo.md",
    content: `- 把 add 改成真正的加法
- 补上 README 的运行说明
`,
  },
];

const MAX_FILES = 24;
const MAX_CONTENT = 8000;

export function safePath(path: string): boolean {
  if (!path || path.length > 80) return false;
  if (path.startsWith("/") || path.startsWith(".") || path.endsWith("/")) return false;
  if (path.includes("\\") || path.includes("..")) return false;
  return /^[A-Za-z0-9._/-]+$/.test(path);
}

export function applyTool(
  files: DeskFile[],
  name: string,
  args: Record<string, unknown>,
): { files: DeskFile[]; detail: string; output: string } {
  if (name === "list_files") {
    const paths = files.map((file) => file.path).sort();
    return { files, detail: `${paths.length} 个文件`, output: paths.join("\n") || "（空）" };
  }
  if (name === "read_file") {
    const path = stringArg(args, "path");
    if (!safePath(path)) return { files, detail: path || "路径", output: "路径不行" };
    const file = files.find((item) => item.path === path);
    if (!file) return { files, detail: path, output: "没有这个文件" };
    return { files, detail: path, output: file.content };
  }
  if (name === "search") {
    const query = stringArg(args, "query").trim();
    if (!query) return { files, detail: "空查询", output: "查询是空的" };
    const hits: string[] = [];
    for (const file of files) {
      file.content.split("\n").forEach((line, index) => {
        if (hits.length >= 15) return;
        if (line.toLowerCase().includes(query.toLowerCase())) hits.push(`${file.path}:${index + 1}: ${line}`);
      });
    }
    return { files, detail: query, output: hits.join("\n") || "没有匹配" };
  }
  if (name === "write_file") {
    const path = stringArg(args, "path");
    const content = stringArg(args, "content");
    if (!safePath(path)) return { files, detail: path || "路径", output: "路径不行" };
    if (content.length > MAX_CONTENT) return { files, detail: path, output: "内容太长" };
    const next = files.filter((file) => file.path !== path);
    if (!files.some((file) => file.path === path) && next.length >= MAX_FILES) {
      return { files, detail: path, output: "文件数量到顶了" };
    }
    next.push({ path, content });
    next.sort((left, right) => left.path.localeCompare(right.path));
    return { files: next, detail: path, output: `已写入 ${path}，${content.length} 个字符` };
  }
  if (name === "delete_file") {
    const path = stringArg(args, "path");
    if (!safePath(path)) return { files, detail: path || "路径", output: "路径不行" };
    if (!files.some((file) => file.path === path)) return { files, detail: path, output: "没有这个文件" };
    return { files: files.filter((file) => file.path !== path), detail: path, output: `已删除 ${path}` };
  }
  return { files, detail: name, output: `没有工具 ${name}` };
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}
