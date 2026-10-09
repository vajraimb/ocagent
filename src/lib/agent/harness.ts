export const HARNESS_IDS = ["files", "web", "net", "ocaml"] as const;

export type HarnessId = (typeof HARNESS_IDS)[number];

export type HarnessSpec = {
  id: HarnessId;
  name: string;
  moduleName: string;
  summary: string;
  tools: string;
};

// `source` is where the module came from (a workspace path or a raw URL) and
// `at` when it was installed, so the panel can show provenance and re-fetch.
export type DeskModule = { name: string; body: string; source?: string; at?: number };

export const CATALOG: HarnessSpec[] = [
  {
    id: "files",
    name: "文件",
    moduleName: "Files",
    summary: "只动工作区里的文件，不看网页。",
    tools: "Files.read_file · write_file · replace · append · delete_file · find_in_files",
  },
  {
    id: "web",
    name: "网页",
    moduleName: "Search",
    summary: "查公开网页。没有第二个搜索。",
    tools: "Search.query",
  },
  {
    id: "net",
    name: "网络",
    moduleName: "Net",
    summary: "请求公网地址，GET 或 POST；返回的 JSON 可以直接取字段。",
    tools: "Net.get · Net.post · Json",
  },
  {
    id: "ocaml",
    name: "运行",
    moduleName: "OCaml",
    summary: "把工作区或网上的 .ml 装成 module，之后每一步都能直接调用。",
    tools: "Harness.load · Harness.install · Harness.unload",
  },
];

export const DEFAULT_HARNESSES: HarnessId[] = ["files", "web", "net", "ocaml"];

const LEGACY: Record<string, HarnessId> = { search: "web" };

export function isHarnessId(value: string): value is HarnessId {
  return (HARNESS_IDS as readonly string[]).includes(value);
}

export function normalizeHarnesses(raw: unknown): HarnessId[] {
  if (!Array.isArray(raw)) return [...DEFAULT_HARNESSES];
  const ids: HarnessId[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const id = isHarnessId(item) ? item : LEGACY[item];
    if (!id || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids;
}

const MODULE_NAME = /^[A-Z][A-Za-z0-9_]{0,24}$/;
const RESERVED = new Set(["Net", "Search", "Files", "Stdlib", "OCaml", "Step", "Trace", "Clock", "Harness", "Plan", "Memory", "Json", "Check", "STEP"]);
const BANNED = /\bObj\.|\bMarshal\.|#\s*(load|use|directory|mod_use)|Sys\.(command|getenv|readdir|chdir|remove|rename|set_signal)\b/;

/** The first forbidden call in a would-be module, for an error message that names it. */
export function bannedCall(body: string): string | null {
  const hit = body.match(BANNED);
  return hit ? hit[0].trim() : null;
}

export function checkModule(name: string, body: string): DeskModule | null {
  const moduleName = name.trim();
  const source = body.trim();
  if (!MODULE_NAME.test(moduleName) || RESERVED.has(moduleName)) return null;
  if (!source || BANNED.test(source)) return null;
  return { name: moduleName, body: source };
}

export function moduleFromFile(name: string, content: string): DeskModule | null {
  const trimmed = content.trim();
  const moduleName = name.trim();
  const start = trimmed.match(new RegExp(`^module\\s+${moduleName}\\s*=\\s*struct\\s*`));
  if (!start) return checkModule(moduleName, trimmed);
  const rest = trimmed.slice(start[0].length);
  const end = rest.lastIndexOf("\nend");
  const body = (end >= 0 ? rest.slice(0, end) : rest).trim();
  return checkModule(moduleName, body);
}

export const MAX_MODULES = 6;

// "src/fib_fast.ml" → "Fib_fast", the way the loop names a claimed file.
export function moduleNameFor(path: string): string | null {
  const base = path.split("/").pop() ?? "";
  if (!base.endsWith(".ml")) return null;
  const stem = base.slice(0, -3);
  if (!stem) return null;
  const name = stem[0]!.toUpperCase() + stem.slice(1);
  return MODULE_NAME.test(name) && !RESERVED.has(name) ? name : null;
}

// "…/stdlib/option.ml" at the end of a URL → "Option".
export function moduleNameFromUrl(url: string): string | null {
  try {
    const base = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    const stem = base.endsWith(".ml") ? base.slice(0, -3) : base;
    if (!stem) return null;
    const cleaned = stem.replace(/[^A-Za-z0-9_]/g, "_");
    const name = cleaned[0]!.toUpperCase() + cleaned.slice(1);
    return MODULE_NAME.test(name) && !RESERVED.has(name) ? name : null;
  } catch {
    return null;
  }
}

// Top-level bindings a module offers, so the panel and the prompt can say
// "Fib: fib, fib_list" without compiling anything.
export function moduleExports(body: string): string[] {
  const names: string[] = [];
  for (const line of body.split("\n")) {
    const match = /^(?:let|and)\s+(?:rec\s+)?(?:\(\s*)?([a-z_][A-Za-z0-9_']*)/.exec(line);
    const name = match?.[1];
    if (name && name !== "_" && !names.includes(name)) names.push(name);
  }
  return names;
}

export function normalizeModules(raw: unknown): DeskModule[] {
  if (!Array.isArray(raw)) return [];
  const modules: DeskModule[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const name = "name" in item && typeof item.name === "string" ? item.name : "";
    const body = "body" in item && typeof item.body === "string" ? item.body : "";
    const mod = checkModule(name, body);
    if (!mod || modules.some((kept) => kept.name === mod.name)) continue;
    const source = "source" in item && typeof item.source === "string" && item.source.trim() ? item.source.trim().slice(0, 300) : undefined;
    const at = "at" in item && typeof item.at === "number" && Number.isFinite(item.at) && item.at > 0 ? Math.floor(item.at) : undefined;
    modules.push({ ...mod, ...(source ? { source } : {}), ...(at ? { at } : {}) });
    if (modules.length >= MAX_MODULES) break;
  }
  return modules;
}

export function spec(id: HarnessId): HarnessSpec {
  const found = CATALOG.find((item) => item.id === id);
  if (!found) throw new Error(`unknown harness ${id}`);
  return found;
}
