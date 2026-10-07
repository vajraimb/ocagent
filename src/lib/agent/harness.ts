export const HARNESS_IDS = ["files", "web", "net", "ocaml"] as const;

export type HarnessId = (typeof HARNESS_IDS)[number];

export type HarnessSpec = {
  id: HarnessId;
  name: string;
  moduleName: string;
  summary: string;
  tools: string;
  source: string;
};

export type DeskModule = { name: string; body: string };

const CALL = `let quote s =
  let buf = Buffer.create (String.length s + 2) in
  Buffer.add_char buf '\\'';
  String.iter (fun c -> if c = '\\'' then Buffer.add_string buf "'\\\\''" else Buffer.add_char buf c) s;
  Buffer.add_char buf '\\'';
  Buffer.contents buf

let slurp path =
  let ic = open_in path in
  let n = in_channel_length ic in
  let s = really_input_string ic n in
  close_in ic;
  s

let call op payload =
  let req = Filename.temp_file "ocagent" ".in" in
  let resp = req ^ ".out" in
  let oc = open_out req in
  output_string oc payload;
  close_out oc;
  let cmd = String.concat " " [
    quote (Sys.getenv "OCAGENT_NODE");
    quote (Sys.getenv "OCAGENT_CLIENT");
    quote op;
    quote req;
    quote resp;
  ] in
  let code = Sys.command cmd in
  let body = try slurp resp with _ -> "" in
  if code <> 0 then failwith (if body = "" then "harness 调用失败" else body) else body
`;

const NET = `module Net = struct
  let get url = call "net" url
end
`;

const SEARCH = `module Search = struct
  let query q = call "search" q
end
`;

const FILES = `module Files = struct
  (* list_files *)
  (* read_file *)
  (* find_in_files *)
  (* write_file *)
  (* delete_file *)
end
`;

const RUNNER = `(* ocaml_run *)
(* 只加载已经加上的 module *)
`;

export const CATALOG: HarnessSpec[] = [
  {
    id: "files",
    name: "文件",
    moduleName: "Files",
    summary: "只动工作区里的文件，不看网页。",
    tools: "list_files · read_file · find_in_files · write_file · delete_file",
    source: FILES.trim(),
  },
  {
    id: "web",
    name: "网页",
    moduleName: "Search",
    summary: "查公开网页。没有第二个搜索。",
    tools: "web_search · Search.query",
    source: SEARCH.trim(),
  },
  {
    id: "net",
    name: "网络",
    moduleName: "Net",
    summary: "请求一个公网地址。",
    tools: "http_get · Net.get",
    source: NET.trim(),
  },
  {
    id: "ocaml",
    name: "运行",
    moduleName: "OCaml",
    summary: "跑工作区里的 .ml，并加载已经加上的 module。",
    tools: "ocaml_run",
    source: RUNNER.trim(),
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

export function prelude(enabled: HarnessId[], modules: DeskModule[] = []): string {
  const parts = [CALL];
  if (enabled.includes("net")) parts.push(NET);
  if (enabled.includes("web")) parts.push(SEARCH);
  if (enabled.includes("ocaml")) {
    for (const mod of modules) parts.push(`module ${mod.name} = struct\n${mod.body}\nend\n`);
  }
  return parts.join("\n");
}

const MODULE_NAME = /^[A-Z][A-Za-z0-9_]{0,24}$/;
const RESERVED = new Set(["Net", "Search", "Files", "Stdlib", "OCaml"]);
const BANNED = /\bObj\.|\bMarshal\.|#\s*(load|use|directory|mod_use)|Sys\.(command|getenv|readdir|chdir|remove|rename|set_signal)\b/;

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

export function normalizeModules(raw: unknown): DeskModule[] {
  if (!Array.isArray(raw)) return [];
  const modules: DeskModule[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const name = "name" in item && typeof item.name === "string" ? item.name : "";
    const body = "body" in item && typeof item.body === "string" ? item.body : "";
    const mod = checkModule(name, body);
    if (!mod || modules.some((kept) => kept.name === mod.name)) continue;
    modules.push(mod);
    if (modules.length >= 6) break;
  }
  return modules;
}

export function spec(id: HarnessId): HarnessSpec {
  const found = CATALOG.find((item) => item.id === id);
  if (!found) throw new Error(`unknown harness ${id}`);
  return found;
}
