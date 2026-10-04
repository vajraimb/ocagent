export const HARNESS_IDS = ["search", "net", "ocaml"] as const;

export type HarnessId = (typeof HARNESS_IDS)[number];

export type HarnessSpec = {
  id: HarnessId;
  name: string;
  summary: string;
  signature: string;
  source: string;
};

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

export const CATALOG: HarnessSpec[] = [
  {
    id: "search",
    name: "搜索",
    summary: "查网页。OCaml 里用 Search.query。",
    signature: "val query : string -> string",
    source: SEARCH.trim(),
  },
  {
    id: "net",
    name: "网络",
    summary: "请求一个公网地址。OCaml 里用 Net.get。",
    signature: "val get : string -> string",
    source: NET.trim(),
  },
  {
    id: "ocaml",
    name: "OCaml",
    summary: "跑工作区里的 .ml。已打开的 harness 会接进同一次运行。",
    signature: "val call : string -> string -> string",
    source: CALL.trim(),
  },
];

export const DEFAULT_HARNESSES: HarnessId[] = [];

export function isHarnessId(value: string): value is HarnessId {
  return (HARNESS_IDS as readonly string[]).includes(value);
}

export function normalizeHarnesses(raw: unknown): HarnessId[] {
  if (!Array.isArray(raw)) return [...DEFAULT_HARNESSES];
  const ids: HarnessId[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !isHarnessId(item) || ids.includes(item)) continue;
    ids.push(item);
  }
  return ids;
}

export function prelude(enabled: HarnessId[]): string {
  const parts = [CALL];
  if (enabled.includes("net")) parts.push(NET);
  if (enabled.includes("search")) parts.push(SEARCH);
  return parts.join("\n");
}

export function spec(id: HarnessId): HarnessSpec {
  const found = CATALOG.find((item) => item.id === id);
  if (!found) throw new Error(`unknown harness ${id}`);
  return found;
}
