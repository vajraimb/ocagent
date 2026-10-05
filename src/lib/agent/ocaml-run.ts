import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkModule, prelude, type DeskModule, type HarnessId } from "./harness.ts";
import { settle } from "./budget.ts";
import { fetchPublic } from "./net.ts";
import { STDLIB_FILES } from "./ocaml-stdlib.ts";
import { searchWeb } from "./search.ts";
import { safePath, type DeskFile, type JournalItem, type ToolStep } from "./workspace.ts";

const SYSTEM_OCAML = "/root/.opam/5.3.0/bin/ocaml";

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

const CLIENT = `import { readFileSync, writeFileSync } from "node:fs";
const [op, inputPath, outputPath] = process.argv.slice(2);
const payload = readFileSync(inputPath, "utf8").slice(0, 200000);
const res = await fetch("http://127.0.0.1:" + process.env.OCAGENT_PORT + "/call", {
  method: "POST",
  headers: { "content-type": "application/json", "x-ocagent-token": process.env.OCAGENT_TOKEN ?? "" },
  body: JSON.stringify({ op, payload }),
});
const text = await res.text();
writeFileSync(outputPath, text);
process.exit(res.ok ? 0 : 1);
`;

export async function runOcaml(
  files: DeskFile[],
  entry: string,
  opts?: { apiKey?: string; harnesses?: HarnessId[]; modules?: DeskModule[] },
): Promise<string> {
  if (!safePath(entry) || !entry.endsWith(".ml")) return "只能跑工作区里的一个 .ml 文件。";
  const source = files.find((file) => file.path === entry);
  if (!source) return `没有 ${entry}`;
  const command = await ocamlCommand();
  if (!command) return "这台服务器没有 OCaml 运行器。";
  if (command.prefix.length > 0 && !command.lib) return "标准库没有装上。";
  const harnesses = opts?.harnesses ?? [];
  const bridge = harnesses.some((id) => id === "net" || id === "web")
    ? await startBridge(opts?.apiKey, harnesses)
    : null;

  await ensureRuntime();
  const dir = await mkdtemp(path.join(RUNTIME, "runs", "ml-"));
  try {
    for (const file of files) {
      if (!file.path.endsWith(".ml") || !safePath(file.path)) continue;
      const target = path.resolve(dir, file.path);
      if (!target.startsWith(dir + path.sep)) continue;
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
    }
    await writeFile(path.join(dir, "ocagent_harness.ml"), prelude(harnesses, opts?.modules ?? []), "utf8");
    await writeFile(path.join(dir, "ocagent_client.mjs"), CLIENT, "utf8");
    const driver = `#use "ocagent_harness.ml";;\n#use "${entry}";;\n`;
    await writeFile(path.join(dir, "ocagent_driver.ml"), driver, "utf8");
    const extra: Record<string, string> = {
      OCAGENT_NODE: process.execPath,
      OCAGENT_CLIENT: path.join(dir, "ocagent_client.mjs"),
    };
    if (command.lib) {
      extra.OCAMLLIB = command.lib;
      extra.CAMLLIB = command.lib;
    }
    if (bridge) {
      extra.OCAGENT_PORT = String(bridge.port);
      extra.OCAGENT_TOKEN = bridge.token;
    }
    const runtimeLib = "/usr/lib/ocagent-rt/lib";
    extra.OCAMLLIB = runtimeLib;
    extra.CAMLLIB = runtimeLib;
    const run = "/usr/lib/ocagent-rt/ocamlrun";
    const image = "/usr/lib/ocagent-rt/ocaml";
    const ran = await execute(run, [image, path.join(dir, "ocagent_driver.ml")], dir, extra, { sandbox: true, timeoutMs: 8_000 });
    return ran.text;
  } finally {
    if (bridge) await bridge.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function startBridge(apiKey: string | undefined, harnesses: HarnessId[]) {
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
    const payload = (body.payload ?? "").slice(0, 4000);
    const permitted = (op === "net" && allow.has("net")) || (op === "search" && allow.has("web"));
    if (!permitted) {
      res.writeHead(403);
      res.end("这个 harness 没开");
      return;
    }
    try {
      const text = op === "net" ? await fetchPublic(payload) : apiKey ? await searchWeb(apiKey, payload) : "Grok 没有接上。";
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(text.slice(0, 4000));
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
  opts?: { sandbox?: boolean; timeoutMs?: number },
): Promise<{ text: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let killer: ReturnType<typeof setTimeout> | undefined;
    let backup: ReturnType<typeof setTimeout> | undefined;
    const finish = (text: string, timeout: boolean) => {
      if (settled) return;
      settled = true;
      if (killer) clearTimeout(killer);
      if (backup) clearTimeout(backup);
      resolve({ text, timedOut: timeout });
    };
    const env = { PATH: "/usr/bin:/bin", HOME: cwd, TMPDIR: cwd, LANG: "C.UTF-8", ...extra };
    const child = opts?.sandbox
      ? spawn("unshare", ["--user", "--map-root-user", "--mount", "/usr/lib/ocagent-rt/enter.sh", cwd, bin, ...args], {
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
      if (timedOut) finish(text || "时限到了，已经停掉。", true);
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
  });
}

const RUNTIME = "/usr/lib/ocagent-rt";

export async function ensureRuntime(): Promise<void> {
  await mkdir(`${RUNTIME}/lib`, { recursive: true });
  await mkdir(`${RUNTIME}/empty`, { recursive: true });
  await mkdir(`${RUNTIME}/runs`, { recursive: true });
  const run = await fileAt("ocamlrun");
  const image = await fileAt("ocaml");
  if (!run || !image) throw new Error("没有 OCaml 运行器");
  await copyFile(run, `${RUNTIME}/ocamlrun`);
  await copyFile(image, `${RUNTIME}/ocaml`);
  await chmod(`${RUNTIME}/ocamlrun`, 0o755);
  const lib = await ensureLib();
  if (!lib) throw new Error("标准库没有装上");
  for (const name of STDLIB_FILES) {
    await copyFile(path.join(lib, name), `${RUNTIME}/lib/${name}`);
  }
  await copyFile("/bin/sh", `${RUNTIME}/sh-real`);
  await chmod(`${RUNTIME}/sh-real`, 0o755);
  const wrapper = `#!${RUNTIME}/sh-real
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
exec ${RUNTIME}/sh-real -c "$cmd"
`;
  await writeFile(`${RUNTIME}/sh`, wrapper, { mode: 0o755 });
  const enter = `#!${RUNTIME}/sh-real
work=$1
shift
mount --bind ${RUNTIME}/sh /bin/sh || exit 1
for d in /workspace /root /home /opt /var /usr/local /etc /proc /sys; do
  if [ -d "$d" ]; then
    mount --bind ${RUNTIME}/empty "$d" && mount -o remount,bind,ro "$d" || true
  fi
done
mount -t tmpfs tmpfs /tmp || exit 1
mkdir -p /tmp/work
mount --bind "$work" /tmp/work || exit 1
cd /tmp/work || exit 1
mount --bind ${RUNTIME} ${RUNTIME} || exit 1
mount -o remount,bind,ro ${RUNTIME} || exit 1
export TMPDIR=/tmp/work HOME=/tmp/work OCAGENT_CLIENT=/tmp/work/ocagent_client.mjs
exec "$@"
`;
  await writeFile(`${RUNTIME}/enter.sh`, enter, { mode: 0o755 });
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

async function agentBin(): Promise<{ run: string; image: string }> {
  await ensureRuntime();
  const image = await fileAt("ocagent");
  if (!image) throw new Error("没有 OCaml 循环");
  await copyFile(image, `${RUNTIME}/ocagent`);
  return { run: `${RUNTIME}/ocamlrun`, image: `${RUNTIME}/ocagent` };
}

export async function runCore(
  job: CoreJob,
  handlers: {
    model: (prompt: string) => Promise<string>;
    net: (url: string) => Promise<string>;
    search: (query: string) => Promise<string>;
    ocaml: (payload: string) => Promise<string>;
  },
): Promise<CoreResult> {
  const { run, image } = await agentBin();
  const dir = await mkdtemp(path.join(RUNTIME, "runs", "job-"));
  const bridge = await startCoreBridge(handlers);
  try {
    await writeFile(path.join(dir, "job"), encodeJob(job));
    await writeFile(path.join(dir, "ocagent_client.mjs"), CLIENT, "utf8");
    const ran = await execute(
      run,
      [image, path.join(dir, "job"), path.join(dir, "result")],
      dir,
      {
        OCAGENT_NODE: process.execPath,
        OCAGENT_CLIENT: path.join(dir, "ocagent_client.mjs"),
        OCAGENT_PORT: String(bridge.port),
        OCAGENT_TOKEN: bridge.token,
      },
      { timeoutMs: 42_000 },
    );
    const resultPath = path.join(dir, "result");
    if (await exists(resultPath)) {
      try {
        const decoded = decodeResult(await readFile(resultPath));
        if (decoded.status === "error") return { ...decoded, answer: decoded.answer || "循环没有跑起来。" };
        if (decoded.status === "done" && decoded.answer.trim()) return decoded;
        const answer =
          decoded.answer.trim() ||
          settle({
            answer: "",
            note: ran.timedOut ? "这一步到时限了。" : "循环停在半路。",
            steps: decoded.steps,
            timedOut: true,
          });
        return { ...decoded, status: "done", answer };
      } catch {
        /* the checkpoint was only half written */
      }
    }
    return {
      status: "done",
      answer: ran.timedOut ? "时限到了，还没有结果。把任务写短一点，或点继续。" : ran.text || "循环没有留下结果。",
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

function startCoreBridge(handlers: {
  model: (prompt: string) => Promise<string>;
  net: (url: string) => Promise<string>;
  search: (query: string) => Promise<string>;
  ocaml: (payload: string) => Promise<string>;
}) {
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
      const text =
        op === "model" ? await handlers.model(payload) : op === "net" ? await handlers.net(payload) : op === "search" ? await handlers.search(payload) : op === "ocaml" ? await handlers.ocaml(payload) : "不支持的调用";
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

export async function runPayload(payload: string, harnesses: HarnessId[], apiKey: string | undefined): Promise<string> {
  const cur = reader(Buffer.from(payload, "utf8"));
  const entry = cur.block();
  const source = cur.block();
  const count = Number(cur.line());
  const modules: DeskModule[] = [];
  for (let i = 0; i < count; i += 1) modules.push({ name: cur.line(), body: cur.block() });
  if (!safePath(entry) || !entry.endsWith(".ml")) return "只能跑工作区里的一个 .ml 文件。";
  if (dangerous(source) || modules.some((mod) => !checkModule(mod.name, mod.body))) return "沙箱拒绝了这段代码：它想跑进程或离开工作区。";
  return runOcaml([{ path: entry, content: source }], entry, { apiKey, harnesses, modules });
}

function dangerous(source: string): boolean {
  return ["Sys.command", "Sys.getenv", "Sys.chdir", "Sys.remove", "Sys.rename", "Sys.set_signal", "Unix.", "#load", "#directory", "#use"].some((token) => source.includes(token));
}

