import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prelude, type HarnessId } from "./harness.ts";
import { fetchPublic } from "./net.ts";
import { STDLIB_FILES } from "./ocaml-stdlib.ts";
import { searchWeb } from "./search.ts";
import { safePath, type DeskFile } from "./workspace.ts";

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
const payload = readFileSync(inputPath, "utf8").slice(0, 4000);
const res = await fetch("http://127.0.0.1:" + process.env.OCAGENT_PORT + "/call", {
  method: "POST",
  headers: { "content-type": "application/json", "x-ocagent-token": process.env.OCAGENT_TOKEN ?? "" },
  body: JSON.stringify({ op, payload }),
  signal: AbortSignal.timeout(15000),
});
const text = await res.text();
writeFileSync(outputPath, text);
process.exit(res.ok ? 0 : 1);
`;

export async function runOcaml(
  files: DeskFile[],
  entry: string,
  opts?: { apiKey?: string; harnesses?: HarnessId[] },
): Promise<string> {
  if (!safePath(entry) || !entry.endsWith(".ml")) return "只能跑工作区里的一个 .ml 文件。";
  const source = files.find((file) => file.path === entry);
  if (!source) return `没有 ${entry}`;
  const command = await ocamlCommand();
  if (!command) return "这台服务器没有 OCaml 运行器。";
  if (command.prefix.length > 0 && !command.lib) return "标准库没有装上。";
  const harnesses = opts?.harnesses ?? [];
  const bridge = harnesses.some((id) => id === "net" || id === "search")
    ? await startBridge(opts?.apiKey, harnesses)
    : null;

  const dir = await mkdtemp(path.join(tmpdir(), "ocagent-ml-"));
  try {
    for (const file of files) {
      if (!file.path.endsWith(".ml") || !safePath(file.path)) continue;
      const target = path.resolve(dir, file.path);
      if (!target.startsWith(dir + path.sep)) continue;
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
    }
    await writeFile(path.join(dir, "ocagent_harness.ml"), prelude(harnesses), "utf8");
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
    return await execute(command.bin, [...command.prefix, path.join(dir, "ocagent_driver.ml")], dir, extra, 12_000);
  } finally {
    if (bridge) await bridge.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function startBridge(apiKey: string | undefined, harnesses: HarnessId[]) {
  const allow = new Set<string>(harnesses.filter((id) => id === "net" || id === "search"));
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
    if (!allow.has(op)) {
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

function execute(bin: string, args: string[], cwd: string, extra: Record<string, string>, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      env: { PATH: "/usr/bin:/bin", HOME: cwd, TMPDIR: cwd, LANG: "C.UTF-8", ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const take = (buf: Buffer) => {
      if (size > 12_000) return;
      chunks.push(buf);
      size += buf.length;
      if (size > 12_000) child.kill("SIGKILL");
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(`没有跑起来：${err.message}`);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString("utf8").trim().slice(0, 4000);
      if (signal === "SIGKILL") resolve(text ? `运行超时。\n${text}` : "运行超时。");
      else if (code && code !== 0) resolve(`退出码 ${code}\n${text || "没有输出"}`);
      else resolve(text || "（没有输出）");
    });
  });
}
