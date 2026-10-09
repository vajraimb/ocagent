export type DeskFile = { path: string; content: string };

// Pictures the user puts in the workspace are kept as data URLs; the model is
// shown them directly, and steps see only the encoded text.
export function isImageFile(file: Pick<DeskFile, "content">): boolean {
  return file.content.startsWith("data:image/");
}

export function imageBytes(file: Pick<DeskFile, "content">): number {
  const comma = file.content.indexOf(",");
  return comma < 0 ? 0 : Math.floor(((file.content.length - comma - 1) * 3) / 4);
}

// The page stores the desk as changes, not as a whole: only files that are new
// or edited go up, and removals go up by path. A desk full of pictures would
// otherwise be re-uploaded on every settings change, which on a phone is what
// fails ("Load failed") and what blocks every save after it.
export type FileDelta = { put: DeskFile[]; remove: string[] };

export function fileDelta(synced: ReadonlyMap<string, string>, files: DeskFile[]): FileDelta {
  const put = files.filter((file) => synced.get(file.path) !== file.content);
  const present = new Set(files.map((file) => file.path));
  const remove = [...synced.keys()].filter((path) => !present.has(path));
  return { put, remove };
}

/** The server side of a delta: removals first, then puts replace or append, keeping the existing order. */
export function applyFileDelta(current: DeskFile[], delta: FileDelta): DeskFile[] {
  const gone = new Set(delta.remove);
  const next = current.filter((file) => !gone.has(file.path));
  for (const file of delta.put) {
    const at = next.findIndex((item) => item.path === file.path);
    if (at >= 0) next[at] = file;
    else next.push(file);
  }
  return next;
}

// One save request stays well under what mobile networks and the deployment's
// request limit take comfortably; a single bigger file still goes alone.
export const SAVE_BATCH_CHARS = 900_000;

export function batchPuts(put: DeskFile[], limit = SAVE_BATCH_CHARS): DeskFile[][] {
  const batches: DeskFile[][] = [];
  let batch: DeskFile[] = [];
  let size = 0;
  for (const file of put) {
    const chars = file.content.length + file.path.length;
    if (batch.length > 0 && size + chars > limit) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(file);
    size += chars;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

export type ToolStep = {
  tool: string;
  detail: string;
  output: string;
};

export type JournalItem = { kind: string; text: string };

export const SEED: DeskFile[] = [];

export const MAX_FILES = 80;

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
  if (name === "search" || name === "find_in_files") {
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
