import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bannedCall, MAX_MODULES, moduleFromFile, type DeskModule, type HarnessId } from "./harness.ts";
import { fetchPublic, fetchSource, postPublic } from "./net.ts";
import { STDLIB_FILES } from "./ocaml-stdlib.ts";
import { searchWeb } from "./search.ts";
import { isScratchFile, safePath, type DeskFile, type JournalItem, type ToolStep } from "./workspace.ts";

const SYSTEM_OCAML = "/root/.opam/5.3.0/bin/ocaml";

async function installBin(src: string, dest: string): Promise<void> {
  try {
    await copyFile(src, dest);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
    if (code !== "ETXTBSY") throw err;
  }
  await chmod(dest, 0o755);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function fileAt(name: string): Promise<string | null> {
  const beside = fileURLToPath(new URL(`../../../assets/ocaml/bin/${name}`, import.meta.url));
  const fromCwd = path.join(process.cwd(), "assets/ocaml/bin", name);
  for (const candidate of [beside, fromCwd]) {
    if (await exists(candidate)) return candidate;
  }
  try {
    const { useStorage } = await import("nitro/storage");
    for (const [base, key] of [
      ["assets/ocaml", `bin/${name}`],
      ["assets/server", `ocaml/bin/${name}`],
    ] as const) {
      const raw = await useStorage(base).getItem(key);
      const bytes = raw instanceof Uint8Array ? raw : Buffer.isBuffer(raw) ? raw : null;
      if (!bytes) continue;
      const dest = path.join(tmpdir(), "ocagent-ocaml", name);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, bytes);
      await chmod(dest, 0o755);
      return dest;
    }
  } catch {
    return null;
  }
  return null;
}

async function ensureLib(): Promise<string | null> {
  const bundled = [
    fileURLToPath(new URL("../../../assets/ocaml/lib", import.meta.url)),
    path.join(process.cwd(), "assets/ocaml/lib"),
  ];
  for (const dir of bundled) {
    if (await exists(path.join(dir, "stdlib.cmi"))) return dir;
  }
  const dest = path.join(tmpdir(), "ocagent-ocaml", "lib");
  if (await exists(path.join(dest, "stdlib.cmi"))) return dest;
  try {
    const { useStorage } = await import("nitro/storage");
    await mkdir(dest, { recursive: true });
    for (const base of ["assets/ocaml", "assets/server"] as const) {
      let found = false;
      for (const name of STDLIB_FILES) {
        const key = base === "assets/server" ? `ocaml/lib/${name}` : `lib/${name}`;
        const raw = await useStorage(base).getItem(key);
        const bytes = raw instanceof Uint8Array ? raw : Buffer.isBuffer(raw) ? raw : null;
        if (!bytes) continue;
        await writeFile(path.join(dest, name), bytes);
        if (name === "stdlib.cmi") found = true;
      }
      if (found) return dest;
    }
  } catch {
    return null;
  }
  return null;
}

async function ocamlCommand(): Promise<{ bin: string; prefix: string[]; lib: string | null } | null> {
  const run = await fileAt("ocamlrun");
  const image = await fileAt("ocaml");
  if (run && image) return { bin: run, prefix: [image], lib: await ensureLib() };
  if (await exists(SYSTEM_OCAML)) return { bin: SYSTEM_OCAML, prefix: [], lib: null };
  return null;
}

/** The step runner itself could not do its job (as opposed to the step's code failing). */
export class RunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerError";
  }
}

// Payloads carry the whole workspace on every step, so the cap is generous and
// overshooting it is an error the loop can see, never a silent cut.
export const MAX_BRIDGE_PAYLOAD = 16 * 1024 * 1024;

const CLIENT = `import { readFileSync, writeFileSync } from "node:fs";
const [op, inputPath, outputPath] = process.argv.slice(2);
const raw = readFileSync(inputPath);
if (raw.length > ${MAX_BRIDGE_PAYLOAD}) {
  writeFileSync(outputPath, "这一步要带的内容有 " + Math.round(raw.length / 1024) + " KB，超过了上限。工作区太大了，删掉或缩小几个文件。");
  process.exit(1);
}
const payload = raw.toString("utf8");
const res = await fetch("http://127.0.0.1:" + process.env.OCAGENT_PORT + "/call", {
  method: "POST",
  headers: { "content-type": "application/json", "x-ocagent-token": process.env.OCAGENT_TOKEN ?? "" },
  body: JSON.stringify({ op, payload }),
});
const text = await res.text();
writeFileSync(outputPath, text);
process.exit(res.ok ? 0 : 1);
`;

export type RunHooks = {
  signal?: AbortSignal;
  onCall?: (tool: string, detail: string) => void;
  // Modules loaded so far in this run; a step sees them all, and Harness.load
  // / Harness.install add to them through onModule.
  modules?: () => DeskModule[];
  onModule?: (mod: DeskModule) => void;
  onUnload?: (name: string) => void;
  // Files as they were when the task began, for the ones it has changed so
  // far (null: did not exist). A step can Files.restore any of them, and
  // onOrigin records the pre-step content of a file the step changed first.
  origin?: () => OriginMap;
  onOrigin?: (path: string, content: string | null) => void;
};

/** Task-start content by path for files the task changed; null when the file did not exist. */
export type OriginMap = Record<string, string | null>;

// Tools that change a file in the workspace, as logged in a step's effects.
export const FILE_CHANGES = new Set(["Files.write_file", "Files.replace", "Files.append", "Files.delete_file", "Files.restore"]);

export function renderModules(mods: DeskModule[]): string {
  return mods.map((mod) => `module ${mod.name} = struct\n${mod.body}\nend\n`).join("\n");
}

export type ModuleVerdict = { ok: true; module: DeskModule } | { ok: false; error: string };

// A module becomes part of every later step's toplevel, so it has to pass the
// same source bans as a step and actually compile against the harness API.
export async function verifyModule(name: string, rawBody: string, context: DeskModule[] = []): Promise<ModuleVerdict> {
  const stripped = moduleFromFile(name, rawBody);
  if (!stripped) {
    const trimmed = name.trim();
    if (!/^[A-Z][A-Za-z0-9_]{0,24}$/.test(trimmed)) return { ok: false, error: `模块名 ${trimmed || "（空）"} 不行：大写开头，字母数字下划线。` };
    if (!rawBody.trim()) return { ok: false, error: "文件是空的。" };
    const offending = bannedCall(rawBody);
    if (offending) return { ok: false, error: `${trimmed} 不能当 harness：里面用了 ${offending}，这类调用在 module 里是禁止的。` };
    return { ok: false, error: `${trimmed} 这个名字被占用了（Net、Search、Files、Json、Trace、Clock、Harness、Plan、Memory、Check、Schedule、Step 是保留名），换一个。` };
  }
  const banned = rejectedSource(stripped.body);
  if (banned) return { ok: false, error: banned.replace(/^编译失败\n/, "").replaceAll("Step 里", "module 里").replace(/写进文件的源码可以包含.*$/, "").trim() };
  // Compiled together with what is already loaded, so a module that builds on
  // another one passes, and one that clashes with the set is caught now.
  const together = [...context.filter((mod) => mod.name !== stripped.name), stripped];
  const outcome = await compileModules(together);
  if (!outcome.ok) {
    if (outcome.name === stripped.name) return { ok: false, error: outcome.error };
    return { ok: false, error: `装上 ${stripped.name} 后，已装的 ${outcome.name} 编译不过了：${outcome.error}` };
  }
  return { ok: true, module: stripped };
}

export type SetVerdict = { kept: DeskModule[]; dropped: { name: string; error: string }[] };

// Before a run, make sure the modules the page sent still compile as a set;
// a broken one is dropped (and reported) instead of poisoning every step.
export async function verifyModuleSet(modules: DeskModule[]): Promise<SetVerdict> {
  let kept = [...modules];
  const dropped: SetVerdict["dropped"] = [];
  while (kept.length > 0) {
    const outcome = await compileModules(kept);
    if (outcome.ok) break;
    const culprit = outcome.name;
    dropped.push({ name: culprit, error: outcome.error });
    kept = kept.filter((mod) => mod.name !== culprit);
  }
  return { kept, dropped };
}

type CompileOutcome = { ok: true } | { ok: false; name: string; error: string };

async function compileModules(mods: DeskModule[]): Promise<CompileOutcome> {
  const last = mods[mods.length - 1]?.name ?? "";
  const command = await ocamlCommand();
  if (!command) return { ok: false, name: last, error: "这台服务器没有 OCaml 运行器。" };
  await ensureRuntime();
  const dir = await mkdtemp(rt("runs", "mod-"));
  try {
    await writeFile(path.join(dir, "ocagent_api.ml"), stepApi(false, false, false, []), "utf8");
    await writeFile(path.join(dir, "ocagent_modules.ml"), renderModules(mods), "utf8");
    await writeFile(path.join(dir, "ocagent_driver.ml"), '#use "ocagent_api.ml";;\n#use "ocagent_modules.ml";;\nlet () = print_string "harness-ok";;\n', "utf8");
    const ran = await execute(rt("ocamlrun"), [rt("ocaml"), path.join(dir, "ocagent_driver.ml")], dir, { OCAMLLIB: rt("lib"), CAMLLIB: rt("lib") }, { sandbox: true, timeoutMs: 10_000 + 2_000 * mods.length });
    if (ran.timedOut) return { ok: false, name: last, error: "编译或顶层求值超时。module 顶层不要做耗时的事。" };
    if (ran.text.includes("harness-ok") && !/\bError\b/.test(ran.text)) return { ok: true };
    const where = /ocagent_modules\.ml", line (\d+)/.exec(plainText(ran.text));
    const name = (where ? moduleAtLine(mods, Number(where[1])) : null) ?? last;
    return { ok: false, name, error: moduleDiagnostic(ran.text, name, moduleStart(mods, name)) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function moduleAtLine(mods: DeskModule[], line: number): string | null {
  let at = 1;
  for (const mod of mods) {
    const span = renderModules([mod]).split("\n").length;
    if (line < at + span) return mod.name;
    at += span;
  }
  return mods[mods.length - 1]?.name ?? null;
}

// Line on which a module's own `module X = struct` header sits in the rendered file.
function moduleStart(mods: DeskModule[], name: string): number {
  let at = 1;
  for (const mod of mods) {
    if (mod.name === name) return at;
    at += renderModules([mod]).split("\n").length;
  }
  return 1;
}

// eslint-disable-next-line no-control-regex -- the toplevel colours its errors
const ANSI = /\u001b\[[0-9;]*m/g;
const plainText = (raw: string) => raw.replace(ANSI, "");

function moduleDiagnostic(raw: string, name: string, start = 1): string {
  const text = plainText(raw);
  const where = /ocagent_modules\.ml", line (\d+)/.exec(text);
  const error = /Error: ([\s\S]{0,400}?)(?:\n\s*\n|$)/.exec(text);
  const line = where ? `第 ${Math.max(1, Number(where[1]) - start)} 行` : "";
  const reason = error?.[1]?.trim().replace(/\s+/g, " ") ?? text.trim().slice(0, 300);
  return `module ${name} 编译失败${line ? `（${line}）` : ""}：${reason || "没有输出"}`;
}

type BridgeContext = { dir: string; hooks?: RunHooks };

async function harnessOp(payload: string, ctx: BridgeContext): Promise<{ status: number; text: string }> {
  const first = payload.indexOf("\n");
  const second = first < 0 ? -1 : payload.indexOf("\n", first + 1);
  if (first < 0 || second < 0) return { status: 400, text: "请求不对" };
  const op = payload.slice(0, first);
  const name = payload.slice(first + 1, second).trim();
  const rest = payload.slice(second + 1);
  const loaded = ctx.hooks?.modules?.() ?? [];
  if (op === "unload") {
    if (!loaded.some((mod) => mod.name === name)) return { status: 404, text: `没有装着叫 ${name} 的 module。现在装着：${loaded.map((mod) => mod.name).join("、") || "（没有）"}。` };
    ctx.hooks?.onUnload?.(name);
    return { status: 200, text: `已卸下 module ${name}。` };
  }
  if (!loaded.some((mod) => mod.name === name) && loaded.length >= MAX_MODULES) {
    return { status: 409, text: `最多同时装 ${MAX_MODULES} 个 module。先用 Harness.unload 卸下一个。` };
  }
  let body = rest;
  let savedTo = "";
  let source = "";
  if (op === "install") {
    source = rest.trim();
    const fetched = await fetchSource(source);
    if (!fetched.ok) return { status: 502, text: fetched.error };
    body = fetched.text;
    const stem = name ? name[0]!.toLowerCase() + name.slice(1) : "";
    savedTo = `lib/${stem}.ml`;
  } else if (op === "load") {
    // load\n<name>\n<path>\n<body>: the path is only provenance.
    const third = rest.indexOf("\n");
    source = third < 0 ? "" : rest.slice(0, third).trim();
    body = third < 0 ? rest : rest.slice(third + 1);
  } else {
    return { status: 400, text: "不支持的 harness 操作" };
  }
  const verdict = await verifyModule(name, body, loaded);
  if (!verdict.ok) return { status: 422, text: verdict.error };
  if (savedTo) {
    if (!safePath(savedTo)) return { status: 422, text: "模块名不能当文件名。" };
    const target = path.resolve(ctx.dir, savedTo);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body, "utf8");
  }
  ctx.hooks?.onModule?.({ ...verdict.module, ...(source ? { source } : {}), at: Date.now() });
  const where = savedTo ? `已安装到 ${savedTo}，` : "";
  return { status: 200, text: `${where}已加载 module ${verdict.module.name}。从下一步起可以直接调用 ${verdict.module.name}.… 。` };
}

// A step sees up to this much of a Net / Search reply (the prompt shows less;
// the step itself can pick fields out of the rest with Json.get).
const MAX_BRIDGE_REPLY = 16_000;
const MAX_POST_PAYLOAD = 24_000;

function startBridge(apiKey: string | undefined, harnesses: HarnessId[], hooks?: RunHooks, ctx?: BridgeContext) {
  const allow = new Set<string>(harnesses.filter((id) => id === "net" || id === "web"));
  const token = randomBytes(16).toString("hex");
  const server = createServer(async (req, res) => {
    if (req.headers["x-ocagent-token"] !== token) {
      res.writeHead(403);
      res.end("拒绝");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: { op?: string; payload?: string } = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { op?: string; payload?: string };
    } catch {
      res.writeHead(400);
      res.end("请求不对");
      return;
    }
    const op = body.op ?? "";
    if (op === "harness" && ctx) {
      try {
        const payload = (body.payload ?? "").slice(0, 250_000);
        const kind = payload.startsWith("install\n") ? "Harness.install" : "Harness.load";
        hooks?.onCall?.(kind, payload.split("\n")[1] ?? "");
        const outcome = await harnessOp(payload, ctx);
        res.writeHead(outcome.status, { "content-type": "text/plain; charset=utf-8" });
        res.end(outcome.text);
      } catch (err) {
        res.writeHead(500);
        res.end(err instanceof Error ? err.message : "失败");
      }
      return;
    }
    const payload = (body.payload ?? "").slice(0, op === "net_post" ? MAX_POST_PAYLOAD : 4000);
    const permitted = ((op === "net" || op === "net_post") && allow.has("net")) || (op === "search" && allow.has("web"));
    if (!permitted) {
      res.writeHead(403);
      res.end("这个 harness 没开");
      return;
    }
    try {
      let text: string;
      if (op === "net_post") {
        const cut = payload.indexOf("\n");
        const url = cut < 0 ? payload : payload.slice(0, cut);
        hooks?.onCall?.("Net.post", url);
        text = await postPublic(url, cut < 0 ? "" : payload.slice(cut + 1));
      } else {
        hooks?.onCall?.(op === "net" ? "Net.get" : "Search.query", payload);
        text = op === "net" ? await fetchPublic(payload) : apiKey ? await searchWeb(apiKey, payload) : "Grok 没有接上。";
      }
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(text.slice(0, MAX_BRIDGE_REPLY));
    } catch (err) {
      res.writeHead(500);
      res.end(err instanceof Error ? err.message : "失败");
    }
  });
  return new Promise<{ port: number; token: string; close: () => Promise<void> }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        token,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function execute(
  bin: string,
  args: string[],
  cwd: string,
  extra: Record<string, string>,
  opts?: { sandbox?: boolean; timeoutMs?: number; signal?: AbortSignal },
): Promise<{ text: string; timedOut: boolean; aborted: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let killer: ReturnType<typeof setTimeout> | undefined;
    let backup: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      aborted = true;
      killTree();
      backup = setTimeout(() => finish(Buffer.concat(chunks).toString("utf8").trim(), false), 1500);
    };
    const finish = (text: string, timeout: boolean) => {
      if (settled) return;
      settled = true;
      if (killer) clearTimeout(killer);
      if (backup) clearTimeout(backup);
      opts?.signal?.removeEventListener("abort", onAbort);
      resolve({ text, timedOut: timeout, aborted });
    };
    if (opts?.signal?.aborted) {
      resolve({ text: "", timedOut: false, aborted: true });
      return;
    }
    const env = { PATH: "/usr/bin:/bin", HOME: cwd, TMPDIR: cwd, LANG: "C.UTF-8", ...extra };
    const child = opts?.sandbox && sandboxReady
      ? spawn(unshareBin, ["--user", "--map-root-user", "--mount", rt("enter.sh"), cwd, bin, ...args], {
          cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        })
      : spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const chunks: Buffer[] = [];
    let size = 0;
    const killTree = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else child.kill("SIGKILL");
    };
    const take = (buf: Buffer) => {
      if (size > 64_000) return;
      chunks.push(buf);
      size += buf.length;
      if (size > 64_000) killTree();
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (err) => {
      finish(`没有跑起来：${err.message}`, false);
    });
    child.on("close", (code, signal) => {
      const text = Buffer.concat(chunks).toString("utf8").trim().slice(0, 8000);
      if (aborted) finish(text, false);
      else if (timedOut) finish(text || "时限到了，已经停掉。", true);
      else if (signal === "SIGKILL") finish(text ? `${text}\n输出太长，已截断。` : "输出太长，已截断。", false);
      else if (code && code !== 0) finish(`退出码 ${code}\n${text || "没有输出"}`, false);
      else finish(text || "（没有输出）", false);
    });
    if (opts?.timeoutMs && opts.timeoutMs > 0) {
      killer = setTimeout(() => {
        timedOut = true;
        killTree();
        backup = setTimeout(() => finish(Buffer.concat(chunks).toString("utf8").trim() || "时限到了，已经停掉。", true), 1500);
      }, opts.timeoutMs);
    }
    opts?.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const PREFERRED_RUNTIME = "/usr/lib/ocagent-rt";
let runtimeRoot = path.join(tmpdir(), "ocagent-rt");
let sandboxReady = false;
let unshareBin = "";

function rt(...parts: string[]): string {
  return path.join(runtimeRoot, ...parts);
}

async function chooseRuntime(): Promise<void> {
  const fallback = path.join(tmpdir(), "ocagent-rt");
  for (const root of [PREFERRED_RUNTIME, fallback]) {
    try {
      await mkdir(root, { recursive: true });
      const probe = path.join(root, ".write-probe");
      await writeFile(probe, "ok");
      await rm(probe, { force: true });
      runtimeRoot = root;
      return;
    } catch {
      /* this location is missing or read-only; try the next one */
    }
  }
  throw new Error("没有可写的运行目录");
}

export async function ensureRuntime(): Promise<void> {
  await chooseRuntime();
  await mkdir(rt("lib"), { recursive: true });
  await mkdir(rt("empty"), { recursive: true });
  await mkdir(rt("runs"), { recursive: true });
  const run = await fileAt("ocamlrun");
  const image = await fileAt("ocaml");
  if (!run || !image) throw new Error("没有 OCaml 运行器");
  await installBin(run, rt("ocamlrun"));
  await installBin(image, rt("ocaml"));
  const lib = await ensureLib();
  if (!lib) throw new Error("标准库没有装上");
  for (const name of STDLIB_FILES) {
    await copyFile(path.join(lib, name), rt("lib", name));
  }
  sandboxReady = false;
  unshareBin = "";
  if (runtimeRoot.startsWith(tmpdir())) return;
  for (const candidate of ["/usr/bin/unshare", "/bin/unshare"]) {
    if (await exists(candidate)) {
      unshareBin = candidate;
      break;
    }
  }
  if (!unshareBin || !(await exists("/bin/sh"))) return;
  await copyFile("/bin/sh", rt("sh-real"));
  await chmod(rt("sh-real"), 0o755);
  const wrapper = `#!${rt("sh-real")}
cmd=$2
if [ "$1" != "-c" ]; then
  echo "沙箱拒绝了这条命令" >&2
  exit 126
fi
case $cmd in
  *ocagent_client.mjs*) ;;
  *) echo "沙箱拒绝了这条命令" >&2
     exit 126 ;;
esac
case $cmd in
  *";"*|*"|"*|*"&"*) echo "沙箱拒绝了这条命令" >&2
     exit 126 ;;
esac
exec ${rt("sh-real")} -c "$cmd"
`;
  await writeFile(rt("sh"), wrapper, { mode: 0o755 });
  const enter = `#!${rt("sh-real")}
work=$1
shift
mount --bind ${rt("sh")} /bin/sh || exit 1
for d in /workspace /root /home /opt /var /usr/local /etc /proc /sys; do
  if [ -d "$d" ]; then
    mount --bind ${rt("empty")} "$d" && mount -o remount,bind,ro "$d" || true
  fi
done
mount -t tmpfs tmpfs /tmp || exit 1
mkdir -p /tmp/work
mount --bind "$work" /tmp/work || exit 1
cd /tmp/work || exit 1
mount --bind ${runtimeRoot} ${runtimeRoot} || exit 1
mount -o remount,bind,ro ${runtimeRoot} || exit 1
export TMPDIR=/tmp/work HOME=/tmp/work OCAGENT_CLIENT=/tmp/work/ocagent_client.mjs
exec "$@"
`;
  await writeFile(rt("enter.sh"), enter, { mode: 0o755 });
  sandboxReady = true;
}

export type CoreJob = {
  task: string;
  harnesses: HarnessId[];
  files: DeskFile[];
  modules: DeskModule[];
  journal: JournalItem[];
  memory: string;
};

export type CoreResult = {
  status: string;
  answer: string;
  files: DeskFile[];
  modules: DeskModule[];
  steps: ToolStep[];
  journal: JournalItem[];
  memory: string;
};

function block(text: string): Buffer {
  const body = Buffer.from(text, "utf8");
  return Buffer.concat([Buffer.from(`${body.length}\n`), body, Buffer.from("\n")]);
}

function encodeJob(job: CoreJob): Buffer {
  const parts: Buffer[] = [Buffer.from("v1\n"), block(job.task), Buffer.from(`${job.harnesses.length}\n`)];
  for (const id of job.harnesses) parts.push(Buffer.from(`${id}\n`));
  parts.push(Buffer.from(`${job.files.length}\n`));
  for (const file of job.files) parts.push(Buffer.from(`${file.path}\n`), block(file.content));
  parts.push(Buffer.from(`${job.modules.length}\n`));
  for (const mod of job.modules) parts.push(Buffer.from(`${mod.name}\n`), block(mod.body));
  parts.push(Buffer.from(`${job.journal.length}\n`));
  for (const item of job.journal) parts.push(Buffer.from(`${item.kind}\n`), block(item.text));
  parts.push(block(job.memory));
  return Buffer.concat(parts);
}

function reader(buf: Buffer) {
  let i = 0;
  return {
    line() {
      const j = buf.indexOf(0x0a, i);
      const end = j < 0 ? buf.length : j;
      const s = buf.toString("utf8", i, end);
      i = j < 0 ? buf.length : j + 1;
      return s;
    },
    block() {
      const n = Number(this.line());
      if (!Number.isFinite(n) || n < 0 || i + n > buf.length) throw new Error("结果读不到");
      const s = buf.toString("utf8", i, i + n);
      i += n;
      if (buf[i] === 0x0a) i += 1;
      return s;
    },
  };
}

function decodeResult(buf: Buffer): CoreResult {
  const cur = reader(buf);
  cur.line();
  const status = cur.line();
  const answer = cur.block();
  const files: DeskFile[] = [];
  const fileCount = Number(cur.line());
  for (let i = 0; i < fileCount; i += 1) files.push({ path: cur.line(), content: cur.block() });
  const modules: DeskModule[] = [];
  const moduleCount = Number(cur.line());
  for (let i = 0; i < moduleCount; i += 1) modules.push({ name: cur.line(), body: cur.block() });
  const steps: ToolStep[] = [];
  const stepCount = Number(cur.line());
  for (let i = 0; i < stepCount; i += 1) steps.push({ tool: cur.line(), detail: cur.block(), output: cur.block() });
  const journal: JournalItem[] = [];
  const journalCount = Number(cur.line());
  for (let i = 0; i < journalCount; i += 1) journal.push({ kind: cur.line(), text: cur.block() });
  const memory = cur.block();
  return { status, answer, files, modules, steps, journal, memory };
}

// The loop is OCaml source (assets/ocaml/bin/ocagent.ml) that the bundled
// toplevel runs as a script, so changing it needs no compiler.
export const LOOP_SCRIPT = "ocagent.ml";

async function loopScript(): Promise<string> {
  await ensureRuntime();
  const source = await fileAt(LOOP_SCRIPT);
  if (!source) throw new Error("没有 OCaml 循环");
  await copyFile(source, rt(LOOP_SCRIPT));
  return rt(LOOP_SCRIPT);
}

export type CoreHandlers = {
  model: (prompt: string) => Promise<string>;
  ocaml: (payload: string) => Promise<string>;
};

export async function runCore(job: CoreJob, handlers: CoreHandlers, hooks?: RunHooks): Promise<CoreResult> {
  const script = await loopScript();
  const dir = await mkdtemp(rt("runs", "job-"));
  const bridge = await startCoreBridge(handlers);
  try {
    await writeFile(path.join(dir, "job"), encodeJob(job));
    await writeFile(path.join(dir, "ocagent_client.mjs"), CLIENT, "utf8");
    const ran = await execute(
      rt("ocamlrun"),
      [rt("ocaml"), script, path.join(dir, "job"), path.join(dir, "result")],
      dir,
      {
        OCAMLLIB: rt("lib"),
        CAMLLIB: rt("lib"),
        OCAGENT_NODE: process.execPath,
        OCAGENT_CLIENT: path.join(dir, "ocagent_client.mjs"),
        OCAGENT_PORT: String(bridge.port),
        OCAGENT_TOKEN: bridge.token,
      },
      { signal: hooks?.signal },
    );
    const resultPath = path.join(dir, "result");
    if (await exists(resultPath)) {
      try {
        const decoded = decodeResult(await readFile(resultPath));
        if (ran.aborted) return { ...decoded, status: "stopped", answer: stoppedAnswer(decoded.steps) };
        if (decoded.status === "error") return { ...decoded, answer: decoded.answer || "循环没有跑起来。" };
        if (decoded.status === "done" && decoded.answer.trim()) return decoded;
        const answer = decoded.answer.trim() || (ran.timedOut ? "这一步到时限了，上面是已经做出的部分。" : "循环停在半路，上面是已经做出的部分。");
        return { ...decoded, status: "done", answer };
      } catch {
        /* the checkpoint was only half written */
      }
    }
    return {
      status: ran.aborted ? "stopped" : "done",
      answer: ran.aborted ? stoppedAnswer([]) : ran.timedOut ? "时限到了，还没有结果。把任务写短一点，或点继续。" : ran.text || "循环没有留下结果。",
      files: job.files,
      modules: job.modules,
      steps: [],
      journal: job.journal,
      memory: job.memory,
    };
  } finally {
    await bridge.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function stoppedAnswer(steps: ToolStep[]): string {
  const done = steps.filter((step) => step.tool !== "compile" && step.detail !== "推迟").slice(-4);
  const lines = ["已按你的要求停下。"];
  if (done.length) lines.push("停下之前做了：", ...done.map((step) => `${step.tool} ${step.detail}`.trim()));
  lines.push("再发一句话就接着做；工作区里写好的文件都还在。");
  return lines.join("\n");
}

function startCoreBridge(handlers: CoreHandlers) {
  const token = randomBytes(16).toString("hex");
  const server = createServer(async (req, res) => {
    if (req.headers["x-ocagent-token"] !== token) {
      res.writeHead(403);
      res.end("拒绝");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: { op?: string; payload?: string } = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { op?: string; payload?: string };
    } catch {
      res.writeHead(400);
      res.end("请求不对");
      return;
    }
    const op = body.op ?? "";
    const payload = body.payload ?? "";
    try {
      const text = op === "model" ? await handlers.model(payload) : op === "ocaml" ? await handlers.ocaml(payload) : "不支持的调用";
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(text);
    } catch (err) {
      res.writeHead(500);
      res.end(err instanceof Error ? err.message : "失败");
    }
  });
  return new Promise<{ port: number; token: string; close: () => Promise<void> }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        token,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function shortenDiagnostic(raw: string, source = ""): string {
  const text = raw.replace(/\u001b\[[0-9;]*m/g, "");
  const spots = [...text.matchAll(/ocagent_step\.ml", line (\d+), characters (\d+)-(\d+)/g)];
  const actual = spots.at(-1);
  // A syntax error in a step with quote-heavy lines is usually text that needed
  // {|...|}: a quote inside a "..." literal. The parser blames the enclosing
  // struct, so the whole source is looked at, not just the reported line.
  const quoteTrouble = /Syntax error/.test(text) && source.split("\n").some((line) => (line.match(/"/g)?.length ?? 0) >= 3);
  const span = /ocagent_step\.ml", lines (\d+)-(\d+)/.exec(text);
  const where = actual
    ? `编译失败 (第 ${actual[1]} 行，第 ${actual[2]}-${actual[3]} 列)`
    : span
      ? `编译失败 (第 ${span[1]}-${span[2]} 行)`
      : "编译失败";
  const pair = /Type "([^"]+)" is not compatible with type "([^"]+)"/.exec(text) ?? /has type "([^"]+)"\s+but an expression was expected of type\s+"([^"]+)"/.exec(text);
  const got = pair?.[1] ?? /has type ([^\n]+)/.exec(text)?.[1];
  const expected = pair?.[2] ?? /expected of type ([^\n]+)/.exec(text)?.[1];
  const pretty = (type: string) => type.replaceAll("(string, string) result", "string res").replaceAll("(unit, string) result", "unit res");
  const lines = [where];
  if (expected) lines.push(`这里期望: ${pretty(expected.trim())}`);
  if (got) lines.push(`实际是:   ${pretty(got.trim())}`);
  if (!expected && !got) {
    const err = /Error: ([^\n]+)/.exec(text);
    if (err) lines.push(err[1].trim());
  }
  if (/\b(res|result)\b/.test(`${got ?? ""}`) && /\breply\b/.test(`${expected ?? ""} ${text}`)) {
    lines.push("提示: Files、Search、Net 的函数返回 res，需要 match 处理 Ok 和 Error。");
  } else if (/Unbound value|Unbound module/.test(text)) {
    lines.push("提示: 只能用 Files、Json、Search、Net、Trace、Clock、Harness、Plan、Memory、Check、Schedule、已装上的 module，以及标准库里的纯计算。不要用 Unix 或 Sys。");
  } else if (quoteTrouble || /String literal not terminated|Illegal backslash escape|Illegal character/.test(text)) {
    lines.push("提示: 多行、带引号或带反斜杠的文本（文件正文、长答案）用 {|...|} 包起来写，里面不用转义。");
  } else if (/Unbound constructor/.test(text)) {
    lines.push("提示: run 必须返回 Continue、Done、Ask 或 Partial。");
  } else if (/Signature mismatch/.test(text)) {
    lines.push("提示: run 必须返回 Continue、Done、Ask 或 Partial。");
  }
  return lines.join("\n");
}

function codeOutsideLiterals(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    if (source.startsWith("(*", i)) {
      const end = source.indexOf("*)", i + 2);
      i = end < 0 ? source.length : end + 2;
      out += " ";
      continue;
    }
    if (source.startsWith("{|", i)) {
      const end = source.indexOf("|}", i + 2);
      i = end < 0 ? source.length : end + 2;
      out += " ";
      continue;
    }
    const c = source[i];
    if (c === '"') {
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      out += " ";
      continue;
    }
    if (c === "'") {
      i += 1;
      if (source[i] === "\\") i += 2;
      else i += 1;
      if (source[i] === "'") i += 1;
      out += " ";
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function rejectedSource(source: string): string | null {
  const code = codeOutsideLiterals(source);
  if (code.includes("Unix")) return "编译失败\nStep 里不能调用 Unix。要记时间用 Clock.now ()。写进文件的源码可以包含 Unix，那只是文本。";
  if (code.includes("Sys.")) return "编译失败\nStep 里不能调用 Sys。要记时间用 Clock.now ()。写进文件的源码可以包含 Sys.time，那只是文本。";
  if (/\bopen_in\b|\bopen_out\b|\bopen_in_bin\b|\bopen_out_bin\b/.test(code)) return "编译失败\n不要直接打开文件。用 Files.read_file 和 Files.write_file。";
  if (/#\s*(load|use|directory|mod_use)/.test(code)) return "编译失败\n不能加载别的文件。";
  if (/\bObj\.|\bMarshal\./.test(code)) return "编译失败\n不能用 Obj 或 Marshal。";
  return null;
}

function ocamlStringList(items: string[]): string {
  return `[ ${items.map((item) => JSON.stringify(item)).join("; ")} ]`;
}

function stepApi(filesOn: boolean, webOn: boolean, netOn: boolean, loaded: string[]): string {
  return `
type 'a res = ('a, string) result

let quote s =
  let buf = Buffer.create (String.length s + 2) in
  Buffer.add_char buf '\\'';
  String.iter (fun c -> if c = '\\'' then Buffer.add_string buf "'\\\\''" else Buffer.add_char buf c) s;
  Buffer.add_char buf '\\'';
  Buffer.contents buf

let slurp path =
  let ic = open_in path in
  Fun.protect ~finally:(fun () -> close_in ic) (fun () -> really_input_string ic (in_channel_length ic))

let bridge op payload =
  let req = Filename.temp_file "ocagent_" ".in" in
  let resp = req ^ ".out" in
  let oc = open_out req in
  output_string oc payload;
  close_out oc;
  let cmd =
    String.concat " "
      [ quote (Sys.getenv "OCAGENT_NODE"); quote (Sys.getenv "OCAGENT_CLIENT"); quote op; quote req; quote resp ]
  in
  let code = Sys.command cmd in
  let body = try slurp resp with _ -> "" in
  (try Sys.remove req with Sys_error _ -> ());
  (try Sys.remove resp with Sys_error _ -> ());
  if code <> 0 then Error (if body = "" then "调用失败" else body) else Ok body

let effects = open_out_gen [ Open_append; Open_creat ] 0o644 "ocagent_effects"

let one_line s = String.map (fun c -> if c = '\\n' || c = '\\t' || c = '\\r' then ' ' else c) s

let clip_ends s n =
  let len = String.length s in
  if len <= n then s
  else
    let head = n / 2 in
    let tail = n - head in
    String.sub s 0 head ^ " … " ^ String.sub s (len - tail) tail

let log_effect name detail result =
  let shown = clip_ends (one_line result) 2400 in
  output_string effects (name ^ "\\t" ^ one_line detail ^ "\\t" ^ shown ^ "\\n");
  flush effects

let hidden name = String.starts_with ~prefix:"ocagent_" name || String.starts_with ~prefix:"." name

let has_dotdot s =
  let n = String.length s in
  let rec go i = if i + 1 >= n then false else if s.[i] = '.' && s.[i + 1] = '.' then true else go (i + 1) in
  go 0

let safe_rel path =
  path <> "" && String.length path <= 80 && (not (String.starts_with ~prefix:"/" path))
  && (not (String.starts_with ~prefix:"." path))
  && (not (String.ends_with ~suffix:"/" path))
  && (not (has_dotdot path))
  && not (String.contains path '\\\\')

let count_sub text sub =
  let n = String.length text and m = String.length sub in
  let rec go i acc = if i + m > n then acc else if String.sub text i m = sub then go (i + m) (acc + 1) else go (i + 1) acc in
  if m = 0 then 0 else go 0 0

let replace_all text sub by =
  let n = String.length text and m = String.length sub in
  let buf = Buffer.create (n + 16) in
  let rec go i =
    if i >= n then ()
    else if i + m <= n && String.sub text i m = sub then (Buffer.add_string buf by; go (i + m))
    else (Buffer.add_char buf text.[i]; go (i + 1))
  in
  go 0;
  Buffer.contents buf

let rec mkdir_p path =
  if path = "" || path = "." then ()
  else (
    mkdir_p (Filename.dirname path);
    if not (Sys.file_exists path) then try Sys.mkdir path 0o755 with Sys_error _ -> ())

let files_on = ${filesOn ? "true" : "false"}
let web_on = ${webOn ? "true" : "false"}
let net_on = ${netOn ? "true" : "false"}

module Files = struct
  let list_files () =
    if not files_on then []
    else
      let found = ref [] in
      let rec walk prefix dir =
        let names = try Sys.readdir dir with Sys_error _ -> [||] in
        Array.iter
          (fun name ->
            if not (hidden name) then
              let rel = if prefix = "" then name else prefix ^ "/" ^ name in
              let full = Filename.concat dir name in
              if Sys.is_directory full then walk rel full else found := rel :: !found)
          names
      in
      walk "" ".";
      List.sort compare !found

  let read_file path =
    let result =
      if (not files_on) || not (safe_rel path) then Error "路径不行"
      else try Ok (slurp path) with Sys_error _ -> Error "没有这个文件"
    in
    log_effect "Files.read_file" path (match result with Ok s -> "Ok " ^ s | Error e -> "Error " ^ e);
    result

  let find_in_files query =
    if (not files_on) || query = "" then []
    else
      let q = String.lowercase_ascii query in
      let hits = ref [] in
      List.iter
        (fun path ->
          match read_file path with
          | Error _ -> ()
          | Ok text ->
              let rec scan i line_no =
                if i >= String.length text || List.length !hits >= 15 then ()
                else
                  let stop = match String.index_from_opt text i '\\n' with None -> String.length text | Some j -> j in
                  let line = String.sub text i (stop - i) in
                  if q = "" || (let lower = String.lowercase_ascii line in let n = String.length lower and m = String.length q in
                    let rec has i = if i + m > n then false else if String.sub lower i m = q then true else has (i + 1) in has 0)
                  then hits := (path, line_no, line) :: !hits;
                  scan (if stop >= String.length text then stop else stop + 1) (line_no + 1)
              in
              scan 0 1)
        (list_files ());
      log_effect "Files.find_in_files" query (string_of_int (List.length !hits));
      List.rev !hits

  let write_file path content =
    let result =
      if not files_on then Error "文件没开"
      else if not (safe_rel path) then Error "路径不行"
      else (
        mkdir_p (Filename.dirname path);
        let oc = open_out path in
        Fun.protect ~finally:(fun () -> close_out oc) (fun () -> output_string oc content);
        Ok ())
    in
    log_effect "Files.write_file" path (match result with Ok () -> "Ok" | Error e -> "Error " ^ e);
    result

  let delete_file path =
    let result =
      if not files_on then Error "文件没开"
      else if not (safe_rel path) then Error "路径不行"
      else try Sys.remove path; Ok () with Sys_error e -> Error e
    in
    log_effect "Files.delete_file" path (match result with Ok () -> "Ok" | Error e -> "Error " ^ e);
    result

  let replace path old by =
    let result =
      if not files_on then Error "文件没开"
      else if not (safe_rel path) then Error "路径不行"
      else if old = "" then Error "要替换的文本是空的"
      else
        match (try Ok (slurp path) with Sys_error _ -> Error "没有这个文件") with
        | Error e -> Error e
        | Ok text ->
            let n = count_sub text old in
            if n > 0 then (
              let oc = open_out path in
              Fun.protect ~finally:(fun () -> close_out oc) (fun () -> output_string oc (replace_all text old by));
              Ok n)
            else if by <> "" && count_sub text by > 0 then Ok 0
            else Error "文件里没有这段文本（要一字不差，含空格和换行；先 read_file 看看）"
    in
    log_effect "Files.replace" path
      (match result with
      | Ok 0 -> "Ok 已经是改过的内容（文件里没有旧文本、已有新文本），这次 0 处，不用再改"
      | Ok n -> "Ok 替换了 " ^ string_of_int n ^ " 处"
      | Error e -> "Error " ^ e);
    result

  let append path content =
    let result =
      if not files_on then Error "文件没开"
      else if not (safe_rel path) then Error "路径不行"
      else (
        mkdir_p (Filename.dirname path);
        let oc = open_out_gen [ Open_append; Open_creat; Open_wronly ] 0o644 path in
        Fun.protect ~finally:(fun () -> close_out oc) (fun () -> output_string oc content);
        Ok ())
    in
    log_effect "Files.append" path (match result with Ok () -> "Ok" | Error e -> "Error " ^ e);
    result

  (* Files as they were when this task began sit under ocagent_origin/ (only
     those the task has changed so far); a path listed in ocagent_origin_absent
     did not exist then. *)
  let restore path =
    let result =
      if not files_on then Error "文件没开"
      else if not (safe_rel path) then Error "路径不行"
      else
        let src = Filename.concat "ocagent_origin" path in
        let absent =
          match (try Some (slurp "ocagent_origin_absent") with Sys_error _ -> None) with
          | None -> false
          | Some listed -> List.mem path (String.split_on_char '\\n' listed)
        in
        if Sys.file_exists src then (
          mkdir_p (Filename.dirname path);
          let oc = open_out path in
          Fun.protect ~finally:(fun () -> close_out oc) (fun () -> output_string oc (slurp src));
          Ok "已退回任务开始时的版本")
        else if absent then (
          (try Sys.remove path with Sys_error _ -> ());
          Ok "任务开始时没有这个文件，已删掉")
        else if Sys.file_exists path then Ok "这次任务没改过它，现在就是开始时的版本"
        else Error "没有这个文件，任务开始时也没有"
    in
    log_effect "Files.restore" path (match result with Ok s -> "Ok " ^ s | Error e -> "Error " ^ e);
    result
end

(* Assertions: each one is written to the timeline as 通过 / 没通过, so a
   Done backed by passing checks needs no extra check round, and a Done with a
   failing one is sent back. *)
module Check = struct
  let that cond desc =
    log_effect "Check.that" desc (if cond then "通过" else "没通过");
    cond

  let equal expected actual desc =
    let ok = expected = actual in
    log_effect "Check.equal" desc (if ok then "通过" else "没通过：期望 " ^ clip_ends (one_line expected) 120 ^ "，实际 " ^ clip_ends (one_line actual) 120);
    ok

  (* A miss shows how the file actually starts, so a wrongly phrased needle
     (English name vs the Chinese one the file has) is told apart from a
     missing change without another read round. *)
  let contains path needle =
    let text = if files_on && safe_rel path then (try Some (slurp path) with Sys_error _ -> None) else None in
    let ok = needle <> "" && (match text with Some t -> count_sub t needle > 0 | None -> false) in
    let verdict =
      if ok then "通过"
      else match text with
        | None -> "没通过：没有这个文件"
        | Some t -> "没通过：文件里没有这段；文件里实际是：" ^ clip_ends (one_line (String.trim t)) 160
    in
    log_effect "Check.contains" (path ^ " 含 " ^ clip_ends (one_line needle) 80) verdict;
    ok
end

module Json = struct
  type t = Null | Bool of bool | Num of string | Str of string | Arr of t list | Obj of (string * t) list

  exception Bad of string

  let parse src =
    let n = String.length src in
    let i = ref 0 in
    let peek () = if !i < n then src.[!i] else '\\000' in
    let rec ws () = if !i < n && (match src.[!i] with ' ' | '\\n' | '\\t' | '\\r' -> true | _ -> false) then (incr i; ws ()) in
    let expect c = if peek () = c then incr i else raise (Bad (Printf.sprintf "第 %d 字处应是 %c" !i c)) in
    let add_utf8 buf code =
      if code < 0x80 then Buffer.add_char buf (Char.chr code)
      else if code < 0x800 then (
        Buffer.add_char buf (Char.chr (0xC0 lor (code lsr 6)));
        Buffer.add_char buf (Char.chr (0x80 lor (code land 0x3F))))
      else if code < 0x10000 then (
        Buffer.add_char buf (Char.chr (0xE0 lor (code lsr 12)));
        Buffer.add_char buf (Char.chr (0x80 lor ((code lsr 6) land 0x3F)));
        Buffer.add_char buf (Char.chr (0x80 lor (code land 0x3F))))
      else (
        Buffer.add_char buf (Char.chr (0xF0 lor (code lsr 18)));
        Buffer.add_char buf (Char.chr (0x80 lor ((code lsr 12) land 0x3F)));
        Buffer.add_char buf (Char.chr (0x80 lor ((code lsr 6) land 0x3F)));
        Buffer.add_char buf (Char.chr (0x80 lor (code land 0x3F))))
    in
    let hex4 () =
      if !i + 4 > n then raise (Bad "\\\\u 后面不够 4 位");
      let v = int_of_string ("0x" ^ String.sub src !i 4) in
      i := !i + 4;
      v
    in
    let str () =
      expect '"';
      let buf = Buffer.create 32 in
      let rec go () =
        if !i >= n then raise (Bad "字符串没有结束（内容可能被截断了）");
        let c = src.[!i] in
        incr i;
        if c = '"' then ()
        else if c = '\\\\' then (
          if !i >= n then raise (Bad "转义不完整");
          let e = src.[!i] in
          incr i;
          (match e with
          | 'n' -> Buffer.add_char buf '\\n'
          | 't' -> Buffer.add_char buf '\\t'
          | 'r' -> Buffer.add_char buf '\\r'
          | 'b' -> Buffer.add_char buf '\\b'
          | 'f' -> Buffer.add_char buf '\\012'
          | 'u' ->
              let hi = hex4 () in
              if hi >= 0xD800 && hi <= 0xDBFF && !i + 1 < n && src.[!i] = '\\\\' && src.[!i + 1] = 'u' then (
                i := !i + 2;
                let lo = hex4 () in
                add_utf8 buf (0x10000 + ((hi - 0xD800) lsl 10) + (lo - 0xDC00)))
              else add_utf8 buf hi
          | other -> Buffer.add_char buf other);
          go ())
        else (Buffer.add_char buf c; go ())
      in
      go ();
      Buffer.contents buf
    in
    let rec value () =
      ws ();
      match peek () with
      | '{' ->
          incr i;
          ws ();
          if peek () = '}' then (incr i; Obj [])
          else
            let rec fields acc =
              ws ();
              let k = str () in
              ws ();
              expect ':';
              let v = value () in
              ws ();
              match peek () with
              | ',' -> incr i; fields ((k, v) :: acc)
              | '}' -> incr i; Obj (List.rev ((k, v) :: acc))
              | _ -> raise (Bad (Printf.sprintf "第 %d 字处的对象没有正常结束（内容可能被截断了）" !i))
            in
            fields []
      | '[' ->
          incr i;
          ws ();
          if peek () = ']' then (incr i; Arr [])
          else
            let rec items acc =
              let v = value () in
              ws ();
              match peek () with
              | ',' -> incr i; items (v :: acc)
              | ']' -> incr i; Arr (List.rev (v :: acc))
              | _ -> raise (Bad (Printf.sprintf "第 %d 字处的数组没有正常结束（内容可能被截断了）" !i))
            in
            items []
      | '"' -> Str (str ())
      | 't' when !i + 4 <= n && String.sub src !i 4 = "true" -> i := !i + 4; Bool true
      | 'f' when !i + 5 <= n && String.sub src !i 5 = "false" -> i := !i + 5; Bool false
      | 'n' when !i + 4 <= n && String.sub src !i 4 = "null" -> i := !i + 4; Null
      | c when c = '-' || (c >= '0' && c <= '9') ->
          let start = !i in
          while !i < n && (match src.[!i] with '0' .. '9' | '-' | '+' | '.' | 'e' | 'E' -> true | _ -> false) do incr i done;
          Num (String.sub src start (!i - start))
      | _ -> raise (Bad (if !i >= n then "内容是空的或被截断了" else Printf.sprintf "第 %d 字处不是 JSON" !i))
    in
    (* Net.get prefixes its status line; anything before the first { or [ is skipped. *)
    let first = ref n in
    String.iteri (fun k c -> if !first = n && (c = '{' || c = '[') then first := k) src;
    i := !first;
    if !first >= n then raise (Bad "里面没有 JSON（没有 { 或 [）");
    value ()

  let rec print = function
    | Null -> "null"
    | Bool b -> string_of_bool b
    | Num s -> s
    | Str s ->
        let buf = Buffer.create (String.length s + 2) in
        Buffer.add_char buf '"';
        String.iter
          (fun c ->
            match c with
            | '"' -> Buffer.add_string buf "\\\\\\""
            | '\\\\' -> Buffer.add_string buf "\\\\\\\\"
            | '\\n' -> Buffer.add_string buf "\\\\n"
            | '\\t' -> Buffer.add_string buf "\\\\t"
            | '\\r' -> Buffer.add_string buf "\\\\r"
            | c when Char.code c < 32 -> Buffer.add_string buf (Printf.sprintf "\\\\u%04x" (Char.code c))
            | c -> Buffer.add_char buf c)
          s;
        Buffer.add_char buf '"';
        Buffer.contents buf
    | Arr xs -> "[" ^ String.concat "," (List.map print xs) ^ "]"
    | Obj kv -> "{" ^ String.concat "," (List.map (fun (k, v) -> print (Str k) ^ ":" ^ print v) kv) ^ "}"

  let scalar = function Str s -> s | v -> print v

  let find text path =
    match (try Ok (parse text) with Bad e -> Error ("JSON 解析失败：" ^ e) | _ -> Error "JSON 解析失败") with
    | Error e -> Error e
    | Ok root ->
        let segs = List.filter (fun s -> s <> "") (String.split_on_char '.' (String.trim path)) in
        let rec walk v = function
          | [] -> Ok v
          | seg :: rest -> (
              match v with
              | Obj kv -> (
                  match List.assoc_opt seg kv with
                  | Some next -> walk next rest
                  | None ->
                      let have = List.map fst kv in
                      Error (Printf.sprintf "没有字段 %s（有：%s）" seg (String.concat "、" (List.filteri (fun k _ -> k < 12) have))))
              | Arr xs -> (
                  match int_of_string_opt seg with
                  | None -> Error (Printf.sprintf "%s 处是数组（%d 项），要用下标，例如 %s" seg (List.length xs) (if rest = [] then "0" else "0." ^ String.concat "." rest))
                  | Some k -> (
                      match List.nth_opt xs k with
                      | Some next -> walk next rest
                      | None -> Error (Printf.sprintf "下标 %d 超出范围（共 %d 项）" k (List.length xs))))
              | other -> Error (Printf.sprintf "%s 处不是对象或数组，是 %s" seg (clip_ends (print other) 60)))
        in
        walk root segs

  let get text path =
    let result = Result.map scalar (find text path) in
    log_effect "Json.get" path (match result with Ok s -> "Ok " ^ clip_ends s 300 | Error e -> "Error " ^ e);
    result

  let items text path =
    let result =
      match find text path with
      | Ok (Arr xs) -> Ok (List.map scalar xs)
      | Ok other -> Error ("不是数组：" ^ clip_ends (print other) 60)
      | Error e -> Error e
    in
    log_effect "Json.items" path (match result with Ok xs -> "Ok " ^ string_of_int (List.length xs) ^ " 项" | Error e -> "Error " ^ e);
    result

  let keys text path =
    let result =
      match find text path with
      | Ok (Obj kv) -> Ok (List.map fst kv)
      | Ok other -> Error ("不是对象：" ^ clip_ends (print other) 60)
      | Error e -> Error e
    in
    log_effect "Json.keys" path (match result with Ok ks -> "Ok " ^ String.concat "、" ks | Error e -> "Error " ^ e);
    result
end

module Search = struct
  let query q =
    let result = if not web_on then Error "网页没开" else if String.trim q = "" then Error "查询是空的" else bridge "search" q in
    log_effect "Search.query" q (match result with Ok s -> "Ok " ^ s | Error e -> "Error " ^ e);
    result
end

module Net = struct
  let get url =
    let result = if not net_on then Error "网络没开" else if String.trim url = "" then Error "地址是空的" else bridge "net" url in
    log_effect "Net.get" url (match result with Ok s -> "Ok " ^ s | Error e -> "Error " ^ e);
    result

  let post url body =
    let result =
      if not net_on then Error "网络没开"
      else if String.trim url = "" then Error "地址是空的"
      else bridge "net_post" (String.trim url ^ "\\n" ^ body)
    in
    log_effect "Net.post" url (match result with Ok s -> "Ok " ^ s | Error e -> "Error " ^ e);
    result
end

module Trace = struct
  let note text =
    log_effect "Trace.note" "" text
end

module Clock = struct
  let now () =
    let t = Sys.time () in
    log_effect "Clock.now" "" (string_of_float t);
    t
end

module Plan = struct
  let set items =
    log_effect "Plan.set" "" (String.concat "\\031" (List.map String.trim items))

  let tick n note =
    log_effect "Plan.tick" (string_of_int n) note
end

module Memory = struct
  let remember text = log_effect "Memory.remember" "" text

  let forget n = log_effect "Memory.forget" (string_of_int n) ""
end

(* Daily schedules: the line is the whole registration; the server validates
   the zone, stores it with the desk and starts a run when it is due. *)
module Schedule = struct
  let is_digit c = c >= '0' && c <= '9'

  let clock_ok s =
    match String.index_opt s ':' with
    | Some i when i >= 1 && i <= 2 && String.length s - i - 1 = 2 ->
        let h = String.sub s 0 i and m = String.sub s (i + 1) 2 in
        String.for_all is_digit h && String.for_all is_digit m
        && int_of_string h <= 23 && int_of_string m <= 59
    | _ -> false

  let daily when_ task =
    let when_ = String.trim when_ in
    let clock = match String.index_opt when_ ' ' with Some i -> String.sub when_ 0 i | None -> when_ in
    let result =
      if not (clock_ok clock) then Error "时间要写成 08:00（默认北京时间），要别的时区就写 08:00 Asia/Tokyo"
      else if String.trim task = "" then Error "要定时做的事是空的"
      else if String.length task > 300 then Error "要定时做的事太长了，一句话说清楚（300 字以内）"
      else Ok ()
    in
    log_effect "Schedule.daily" when_ (match result with Ok () -> "Ok " ^ task | Error e -> "Error " ^ e);
    result

  let cancel n = log_effect "Schedule.cancel" (string_of_int n) ""
end

module Harness = struct
  let loaded () = ${ocamlStringList(loaded)}

  let load name path =
    let result =
      if String.trim name = "" then Error "模块名是空的"
      else if not (safe_rel path) then Error "路径不行"
      else
        match (try Ok (slurp path) with Sys_error _ -> Error "没有这个文件") with
        | Error e -> Error e
        | Ok body -> bridge "harness" ("load\\n" ^ String.trim name ^ "\\n" ^ path ^ "\\n" ^ body)
    in
    log_effect "Harness.load" (String.trim name ^ " <- " ^ path) (match result with Ok s -> "Ok " ^ s | Error e -> "Error " ^ e);
    result

  let install name url =
    let result =
      if String.trim name = "" then Error "模块名是空的"
      else if String.trim url = "" then Error "地址是空的"
      else bridge "harness" ("install\\n" ^ String.trim name ^ "\\n" ^ String.trim url)
    in
    log_effect "Harness.install" (String.trim name ^ " <- " ^ String.trim url) (match result with Ok s -> "Ok " ^ s | Error e -> "Error " ^ e);
    result

  let unload name =
    let result =
      if String.trim name = "" then Error "模块名是空的"
      else bridge "harness" ("unload\\n" ^ String.trim name ^ "\\n")
    in
    log_effect "Harness.unload" (String.trim name) (match result with Ok s -> "Ok " ^ s | Error e -> "Error " ^ e);
    result
end

type reply =
  | Continue of string
  | Done of string
  | Ask of string
  | Partial of string

module type STEP = sig
  val run : unit -> reply
end
`;
}

const STEP_FINISH = `
let () =
  let kind, text =
    match Step.run () with
    | Continue s -> ("continue", s)
    | Done s -> ("done", s)
    | Ask s -> ("ask", s)
    | Partial s -> ("partial", s)
  in
  let oc = open_out_bin "ocagent_step_out" in
  output_string oc kind;
  output_char oc '\\n';
  output_string oc (string_of_int (String.length text));
  output_char oc '\\n';
  output_string oc text;
  output_char oc '\\n';
  close_out oc
`;

function encodeBlock(text: string): string {
  const body = Buffer.from(text, "utf8");
  return `${body.length}\n${body.toString("utf8")}\n`;
}

async function collectFiles(dir: string, root = dir, out: DeskFile[] = []): Promise<DeskFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith("ocagent_") || entry.name.startsWith(".") || isScratchFile(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (!safePath(rel)) continue;
    if (entry.isDirectory()) await collectFiles(abs, root, out);
    else if (entry.isFile()) {
      try {
        const content = await readFile(abs, "utf8");
        if (!content.includes("\u0000")) out.push({ path: rel, content });
      } catch {
        /* skip unreadable files */
      }
    }
  }
  return out;
}

export async function runStep(payload: string, harnesses: HarnessId[], apiKey: string | undefined, hooks?: RunHooks): Promise<string> {
  let source = "";
  const files: DeskFile[] = [];
  try {
    const cur = reader(Buffer.from(payload, "utf8"));
    source = cur.block();
    const count = Number(cur.line());
    for (let i = 0; i < count; i += 1) files.push({ path: cur.line(), content: cur.block() });
  } catch {
    const kb = Math.round(Buffer.byteLength(payload) / 1024);
    throw new RunnerError(`这一步的输入没有读全（收到 ${kb} KB，${files.length} 个文件后断了）。工作区可能太大，删掉或缩小几个大文件再试。`);
  }
  const banned = rejectedSource(source);
  if (banned) return `fail\n${encodeBlock(banned)}`;
  const command = await ocamlCommand();
  if (!command) return `fail\n${encodeBlock("这台服务器没有 OCaml 运行器。")}`;
  await ensureRuntime();
  const dir = await mkdtemp(rt("runs", "step-"));
  const bridge = await startBridge(apiKey, harnesses, hooks, { dir, hooks });
  try {
    for (const file of files) {
      if (!safePath(file.path)) continue;
      const target = path.resolve(dir, file.path);
      if (!target.startsWith(dir + path.sep)) continue;
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
    }
    const origin = hooks?.origin?.() ?? {};
    const absent: string[] = [];
    for (const [rel, content] of Object.entries(origin)) {
      if (!safePath(rel)) continue;
      if (content === null) {
        absent.push(rel);
        continue;
      }
      const target = path.resolve(dir, "ocagent_origin", rel);
      if (!target.startsWith(path.join(dir, "ocagent_origin") + path.sep)) continue;
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    if (absent.length) await writeFile(path.join(dir, "ocagent_origin_absent"), absent.join("\n"), "utf8");
    const loaded = hooks?.modules?.() ?? [];
    await writeFile(
      path.join(dir, "ocagent_api.ml"),
      stepApi(
        harnesses.includes("files"),
        harnesses.includes("web"),
        harnesses.includes("net"),
        loaded.map((mod) => mod.name),
      ),
      "utf8",
    );
    await writeFile(path.join(dir, "ocagent_modules.ml"), renderModules(loaded), "utf8");
    await writeFile(path.join(dir, "ocagent_step.ml"), `${source.trim()}\n`, "utf8");
    await writeFile(path.join(dir, "ocagent_finish.ml"), STEP_FINISH, "utf8");
    await writeFile(path.join(dir, "ocagent_driver.ml"), '#use "ocagent_api.ml";;\n#use "ocagent_modules.ml";;\n#use "ocagent_step.ml";;\n#use "ocagent_finish.ml";;\n', "utf8");
    await writeFile(path.join(dir, "ocagent_client.mjs"), CLIENT, "utf8");
    const extra: Record<string, string> = {
      OCAGENT_NODE: process.execPath,
      OCAGENT_CLIENT: path.join(dir, "ocagent_client.mjs"),
      OCAMLLIB: rt("lib"),
      CAMLLIB: rt("lib"),
    };
    if (bridge) {
      extra.OCAGENT_PORT = String(bridge.port);
      extra.OCAGENT_TOKEN = bridge.token;
    }
    const ran = await execute(rt("ocamlrun"), [rt("ocaml"), path.join(dir, "ocagent_driver.ml")], dir, extra, { sandbox: true, timeoutMs: 55_000, signal: hooks?.signal });
    const outPath = path.join(dir, "ocagent_step_out");
    if (ran.aborted) return `fail\n${encodeBlock("已停下，这一步没有跑完。")}`;
    if (!(await exists(outPath))) {
      const broken = /ocagent_modules\.ml", line (\d+)/.exec(ran.text.replace(/\u001b\[[0-9;]*m/g, ""));
      if (broken) {
        const culprit = moduleAtLine(loaded, Number(broken[1]));
        return `fail\n${encodeBlock(`编译失败\n已加载的 module ${culprit ?? ""} 本身没有编译通过，这一步没有执行。先在工作区卸下它，或改好后重新 Harness.load。\n${moduleDiagnostic(ran.text, culprit ?? "?")}`)}`;
      }
      return `fail\n${encodeBlock(shortenDiagnostic(ran.text || "没有编译通过", source))}`;
    }
    const outcome = reader(await readFile(outPath));
    const kind = outcome.line();
    const text = outcome.block();
    const effectText = (await exists(path.join(dir, "ocagent_effects"))) ? await readFile(path.join(dir, "ocagent_effects"), "utf8") : "";
    const traces = effectText
      .split("\n")
      .filter((line) => line.startsWith("Trace.note\t"))
      .map((line) => line.split("\t")[2] ?? "")
      .filter(Boolean)
      .join("\n");
    // The first change to a file in this task: remember what it was before,
    // so a later step can step back to it.
    if (hooks?.onOrigin) {
      const before = new Map(files.map((file) => [file.path, file.content]));
      for (const line of effectText.split("\n")) {
        const [tool = "", detail = "", ...rest] = line.split("\t");
        if (!FILE_CHANGES.has(tool) || tool === "Files.restore" || !rest.join("\t").startsWith("Ok")) continue;
        if (detail in origin) continue;
        origin[detail] = before.get(detail) ?? null;
        hooks.onOrigin(detail, origin[detail]);
      }
    }
    const written = await collectFiles(dir);
    let body = `ok\n${kind}\n${encodeBlock(text)}${encodeBlock(traces)}${encodeBlock(effectText.trim())}${written.length}\n`;
    for (const file of written) body += `${file.path}\n${encodeBlock(file.content)}`;
    return body;
  } finally {
    if (bridge) await bridge.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// Everything the loop hands the runner is a step; anything else is a protocol
// mismatch, reported as a frame the loop understands.
export async function runPayload(payload: string, harnesses: HarnessId[], apiKey: string | undefined, hooks?: RunHooks): Promise<string> {
  if (payload.startsWith("step\n")) return runStep(payload.slice(5), harnesses, apiKey, hooks);
  return `fail\n${encodeBlock("循环只会交来 step；这不是一个 step。")}`;
}

