import { useRef, useState } from "react";
import { Blocks, Brain, Check, Download, FilePlus, FileText, Image, Link2, LoaderCircle, PackagePlus, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { CATALOG, MAX_MODULES, moduleExports, moduleNameFor, moduleNameFromUrl, type DeskModule, type HarnessId } from "@/lib/agent/harness";
import { imageBytes, isImageFile, type DeskFile } from "@/lib/agent/workspace";

const FIXED: HarnessId[] = ["ocaml"];

type Verdict = { label: string; error: string | null };

export function SidePanel({
  harnesses,
  setHarnesses,
  modules,
  setModules,
  onInstall,
  onInstallUrl,
  onImport,
  files,
  selected,
  onSelect,
  onReset,
  onClose,
  shareUrl,
  durable,
  busy,
  onAddFiles,
  onRemoveFile,
  notes,
  onForget,
}: {
  harnesses: HarnessId[];
  setHarnesses: (next: HarnessId[]) => void;
  modules: DeskModule[];
  setModules: (next: DeskModule[]) => void;
  onInstall: (file: DeskFile) => Promise<string | null>;
  onInstallUrl: (name: string | null, url: string) => Promise<string | null>;
  onImport: (mod: DeskModule) => Promise<string | null>;
  files: DeskFile[];
  selected: string;
  onSelect: (path: string) => void;
  onReset: () => void;
  onClose?: () => void;
  shareUrl: string;
  durable: boolean;
  busy: boolean;
  onAddFiles: (files: FileList | File[]) => void;
  onRemoveFile: (path: string) => void;
  /** What the agent remembered about this desk; shown in every task's prompt. */
  notes: string[];
  onForget: (index: number) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const file = files.find((item) => item.path === selected) ?? null;
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<{ path: string; text: string } | null>(null);
  const [urlOpen, setUrlOpen] = useState(false);
  const [urlText, setUrlText] = useState("");
  const [working, setWorking] = useState(false);
  const [verdicts, setVerdicts] = useState<Verdict[]>([]);
  const [copied, setCopied] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  const candidate = file ? moduleNameFor(file.path) : null;
  const alreadyLoaded = candidate ? modules.some((mod) => mod.name === candidate) : false;

  async function install(target: DeskFile) {
    setInstalling(true);
    setInstallError(null);
    try {
      const error = await onInstall(target);
      if (error) setInstallError({ path: target.path, text: error });
    } finally {
      setInstalling(false);
    }
  }

  // One raw URL per line, optionally "Name = url"; installed in order so a
  // later module may build on an earlier one.
  async function installUrls() {
    const lines = urlText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) return;
    setWorking(true);
    const results: Verdict[] = [];
    setVerdicts(results);
    try {
      for (const line of lines) {
        const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\S+)$/.exec(line);
        const name = match ? match[1]! : null;
        const url = match ? match[2]! : line;
        const error = await onInstallUrl(name, url);
        results.push({ label: name ?? moduleNameFromUrl(url) ?? url, error });
        setVerdicts([...results]);
      }
      if (results.every((item) => !item.error)) setUrlText("");
    } finally {
      setWorking(false);
    }
  }

  function exportModules() {
    const payload = { "ocagent-harnesses": 1, exportedAt: new Date().toISOString(), modules: modules.map(({ name, body, source }) => ({ name, body, ...(source ? { source } : {}) })) };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `harnesses-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function importFile(picked: File | undefined) {
    if (!picked) return;
    setWorking(true);
    const results: Verdict[] = [];
    setVerdicts(results);
    try {
      const parsed = JSON.parse(await picked.text()) as { modules?: unknown };
      const list = Array.isArray(parsed.modules) ? parsed.modules : [];
      if (!list.length) {
        setVerdicts([{ label: picked.name, error: "这个文件里没有 module。" }]);
        return;
      }
      for (const item of list) {
        if (!item || typeof item !== "object" || typeof (item as DeskModule).name !== "string" || typeof (item as DeskModule).body !== "string") continue;
        const mod = item as DeskModule;
        const error = await onImport({ name: mod.name, body: mod.body, source: typeof mod.source === "string" ? mod.source : undefined });
        results.push({ label: mod.name, error });
        setVerdicts([...results]);
      }
    } catch {
      setVerdicts([{ label: picked.name, error: "读不懂这个文件，要的是「导出」生成的 JSON。" }]);
    } finally {
      setWorking(false);
      if (importInput.current) importInput.current.value = "";
    }
  }

  async function refetch(mod: DeskModule) {
    if (!mod.source || !/^https?:\/\//.test(mod.source)) return;
    setWorking(true);
    try {
      const error = await onInstallUrl(mod.name, mod.source);
      setVerdicts([{ label: mod.name, error: error ?? null }]);
    } finally {
      setWorking(false);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt("复制这个链接：", shareUrl);
    }
  }

  const disabled = busy || working;

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-4">
        <p className="font-mono text-xs tracking-widest text-muted">工作区</p>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void copyLink()}
            disabled={!shareUrl}
            title="复制这个工作区的链接，在别的设备或浏览器打开就是同一个工作区"
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-muted hover:border-fg/30 hover:text-fg disabled:opacity-50"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-accent" aria-hidden /> : <Link2 className="h-3.5 w-3.5" aria-hidden />}
            {copied ? "已复制" : "复制工作区链接"}
          </button>
          {onClose ? (
            <button type="button" onClick={onClose} aria-label="收起工作区" className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:text-fg">
              <X className="h-4 w-4" aria-hidden />
            </button>
          ) : null}
        </div>
      </div>
      {copied ? <p className="px-4 pb-2 text-xs text-muted">在别处打开这个链接，就是同一个工作区：文件、harness 和历史都在。</p> : null}
      {!durable && import.meta.env.PROD ? (
        <p className="mx-4 mb-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs leading-5 text-warn">还没接上数据库：文件和历史只暂存在当前这台服务器上，重启或换一台就没了。部署时配置数据库后才会长期保存。</p>
      ) : null}

      <section className="px-4 pb-4">
        <h2 className="text-sm font-medium text-fg">能力</h2>
        <ul className="mt-2 flex flex-col gap-1">
          {CATALOG.map((item) => {
            const fixed = FIXED.includes(item.id);
            const on = fixed || harnesses.includes(item.id);
            return (
              <li key={item.id}>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  disabled={fixed || busy}
                  onClick={() => setHarnesses(on ? harnesses.filter((kept) => kept !== item.id) : [...harnesses, item.id])}
                  className="flex min-h-11 w-full items-center gap-3 rounded-lg px-2 text-left hover:bg-raised disabled:hover:bg-transparent"
                >
                  <span className={`relative inline-block h-5 w-9 shrink-0 rounded-full transition-colors ${on ? "bg-accent" : "bg-raised"} ${fixed ? "opacity-60" : ""}`}>
                    <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-bg transition-transform ${on ? "translate-x-4" : "translate-x-0.5"}`} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-fg">
                      {item.name}
                      <span className="ml-1.5 font-mono text-xs text-muted">{item.moduleName}</span>
                    </span>
                    <span className="block truncate text-xs text-muted">{fixed ? "始终开着。每一步都在这里编译执行。" : item.summary}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="px-4 pb-4">
        <h2 className="text-sm font-medium text-fg">
          已装的 harness
          <span className="ml-1.5 font-mono text-xs text-muted">
            {modules.length}/{MAX_MODULES}
          </span>
        </h2>
        {modules.length === 0 ? <p className="mt-2 text-xs leading-5 text-muted">还没有。它写好一个 .ml 后可以自己装上；你也可以在下面的文件里点“装为 harness”，或从地址安装、导入别人导出的一组。装上以后，每一步都能直接调用。</p> : null}
        {modules.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-2">
            {modules.map((mod) => (
              <ModuleCard key={mod.name} mod={mod} busy={disabled} onRemove={() => setModules(modules.filter((item) => item.name !== mod.name))} onRefetch={() => void refetch(mod)} />
            ))}
          </ul>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button type="button" disabled={disabled} onClick={() => setUrlOpen((open) => !open)} className="inline-flex min-h-8 items-center gap-1 rounded-md border border-border bg-bg px-2 text-xs text-fg hover:border-accent disabled:opacity-50">
            <PackagePlus className="h-3.5 w-3.5" aria-hidden />
            从地址安装
          </button>
          <button type="button" disabled={disabled} onClick={() => importInput.current?.click()} className="inline-flex min-h-8 items-center gap-1 rounded-md border border-border bg-bg px-2 text-xs text-fg hover:border-accent disabled:opacity-50">
            <Upload className="h-3.5 w-3.5" aria-hidden />
            导入
          </button>
          <input ref={importInput} type="file" accept="application/json,.json" className="hidden" onChange={(event) => void importFile(event.target.files?.[0])} />
          {modules.length > 0 ? (
            <button type="button" onClick={exportModules} className="inline-flex min-h-8 items-center gap-1 rounded-md border border-border bg-bg px-2 text-xs text-fg hover:border-accent">
              <Download className="h-3.5 w-3.5" aria-hidden />
              导出
            </button>
          ) : null}
        </div>
        {urlOpen ? (
          <div className="mt-2 flex flex-col gap-2">
            <label className="block">
              <span className="sr-only">要安装的地址</span>
              <textarea
                value={urlText}
                onChange={(event) => setUrlText(event.target.value)}
                rows={3}
                disabled={disabled}
                placeholder={"一行一个 raw .ml 地址；要指定名字就写\nMyopt = https://…/option.ml"}
                className="block w-full resize-none rounded-lg border border-border bg-bg px-2.5 py-2 font-mono text-[11px] leading-5 text-fg outline-none placeholder:text-muted focus:border-primary"
              />
            </label>
            <button type="button" disabled={disabled || !urlText.trim()} onClick={() => void installUrls()} className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-xs text-primary-fg disabled:opacity-40">
              {working ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <PackagePlus className="h-3.5 w-3.5" aria-hidden />}
              下载并编译检查
            </button>
          </div>
        ) : null}
        {verdicts.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-1">
            {verdicts.map((item, index) => (
              <li key={`${item.label}-${index}`} className={`flex min-w-0 items-start gap-1.5 text-xs leading-5 ${item.error ? "text-danger" : "text-accent"}`}>
                {item.error ? <X className="mt-1 h-3 w-3 shrink-0" aria-hidden /> : <Check className="mt-1 h-3 w-3 shrink-0" aria-hidden />}
                <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                  <span className="font-mono text-fg">{item.label}</span> {item.error ? item.error : "已装上"}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {notes.length > 0 ? (
        <section className="px-4 pb-4">
          <h2 className="flex items-center gap-1.5 text-sm font-medium text-fg">
            <Brain className="h-4 w-4 text-muted" aria-hidden />
            它记住的
            <span className="font-mono text-xs text-muted">{notes.length}</span>
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted">它自己记下、以后每件事都会参考的。记错了就删掉。</p>
          <ul className="mt-2 flex flex-col gap-1">
            {notes.map((note, index) => (
              <li key={`${index}-${note}`} className="group flex min-w-0 items-start gap-2 rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs leading-5 text-fg">
                <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{note}</span>
                <button type="button" disabled={disabled} onClick={() => onForget(index)} aria-label={`忘掉：${note}`} className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted hover:text-danger disabled:opacity-50">
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section
        className={`flex min-h-0 flex-1 flex-col px-4 pb-4 ${dragging ? "rounded-xl outline-2 outline-dashed outline-accent/60" : ""}`}
        onDragOver={(event) => {
          if (busy || !event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          setDragging(false);
          if (busy || event.dataTransfer.files.length === 0) return;
          event.preventDefault();
          onAddFiles(event.dataTransfer.files);
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-fg">
            文件
            {files.length ? <span className="ml-1.5 font-mono text-xs text-muted">{files.length}</span> : null}
          </h2>
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              if (event.target.files?.length) onAddFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <button type="button" disabled={busy} onClick={() => fileInput.current?.click()} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-fg hover:border-accent hover:text-accent disabled:opacity-50">
            <FilePlus className="h-3.5 w-3.5" aria-hidden />
            添加文件
          </button>
        </div>
        {files.length === 0 ? <p className="mt-2 text-xs leading-5 text-muted">{dragging ? "松手就放进工作区。" : "还没有文件。让它写一个，或把自己的文本文件、图片拖到这里、点「添加文件」放进来，然后让它处理。"}</p> : null}
        {files.length > 0 ? (
          <ul className="mt-2 flex flex-col">
            {files.map((item) => {
              const active = item.path === file?.path;
              return (
                <li key={item.path}>
                  <button
                    type="button"
                    onClick={() => onSelect(active ? "" : item.path)}
                    className={`flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left font-mono text-xs ${active ? "bg-raised text-fg" : "text-muted hover:bg-raised hover:text-fg"}`}
                  >
                    {isImageFile(item) ? <Image className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                    <span className="truncate">{item.path}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
        {file ? (
          <div className="mt-2 flex flex-col gap-2">
            {candidate ? (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={disabled || installing || alreadyLoaded}
                  onClick={() => void install(file)}
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border bg-bg px-2.5 text-xs text-fg hover:border-accent hover:text-accent disabled:opacity-50 disabled:hover:border-border disabled:hover:text-fg"
                >
                  {installing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Blocks className="h-3.5 w-3.5" aria-hidden />}
                  {alreadyLoaded ? `${candidate} 已装上` : installing ? "编译检查中" : `装为 harness ${candidate}`}
                </button>
                {installError?.path === file.path ? <p className="min-w-0 flex-1 text-xs leading-5 text-danger">{installError.text}</p> : null}
              </div>
            ) : null}
            {isImageFile(file) ? (
              <img src={file.content} alt={file.path} className="max-h-72 w-full rounded-lg border border-border bg-bg object-contain" />
            ) : (
              <pre className="max-h-72 overflow-auto rounded-lg border border-border bg-bg px-3 py-2 font-mono text-xs leading-5 text-fg">{file.content}</pre>
            )}
            <div className="flex items-center justify-between gap-2 text-xs text-muted">
              <span className="font-mono">{sizeLabel(file.content)}</span>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => downloadFile(file)} className="inline-flex min-h-8 items-center gap-1 rounded-md px-1.5 text-xs text-muted hover:text-fg">
                  <Download className="h-3.5 w-3.5" aria-hidden />
                  下载
                </button>
                <button type="button" disabled={disabled} onClick={() => onRemoveFile(file.path)} className="inline-flex min-h-8 items-center gap-1 rounded-md px-1.5 text-xs text-muted hover:text-danger disabled:opacity-50">
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  删除
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </section>

      <div className="sticky bottom-0 mt-auto flex items-center justify-end border-t border-border bg-bg px-4 py-2">
        <button type="button" onClick={onReset} disabled={busy} className="min-h-10 rounded-lg px-2 text-xs text-muted hover:text-danger disabled:opacity-50">
          清空对话和文件
        </button>
      </div>
    </div>
  );
}

// Saves one workspace file to the viewer's device, under its own name.
function downloadFile(file: DeskFile): void {
  const picture = isImageFile(file);
  const url = picture ? file.content : URL.createObjectURL(new Blob([file.content], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.path.split("/").pop() || "file.txt";
  anchor.click();
  if (!picture) setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function sizeLabel(content: string): string {
  if (isImageFile({ content })) {
    const bytes = imageBytes({ content });
    return `图片 · ${bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`} · 它每轮都能看到`;
  }
  const bytes = new TextEncoder().encode(content).length;
  const lines = content.split("\n").length;
  return bytes < 1024 ? `${bytes} B · ${lines} 行` : `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB · ${lines} 行`;
}

function sourceLabel(source: string | undefined): string {
  if (!source) return "";
  if (/^https?:\/\//.test(source)) {
    try {
      const url = new URL(source);
      const tail = url.pathname.split("/").filter(Boolean).slice(-2).join("/");
      return `${url.host}/…/${tail}`;
    } catch {
      return source;
    }
  }
  return source;
}

function when(at: number | undefined): string {
  if (!at) return "";
  const diff = Date.now() - at;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(at).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function ModuleCard({ mod, busy, onRemove, onRefetch }: { mod: DeskModule; busy: boolean; onRemove: () => void; onRefetch: () => void }) {
  const [showSource, setShowSource] = useState(false);
  const exports = moduleExports(mod.body);
  const shown = exports.slice(0, 8);
  const more = exports.length - shown.length;
  const fromUrl = Boolean(mod.source && /^https?:\/\//.test(mod.source));
  const origin = sourceLabel(mod.source);
  const stamp = when(mod.at);
  return (
    <li className="rounded-lg border border-border bg-surface px-3 py-2">
      <div className="flex items-center gap-2">
        <Blocks className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg">{mod.name}</span>
        {fromUrl ? (
          <button type="button" disabled={busy} onClick={onRefetch} aria-label={`重新下载 ${mod.name}`} title="重新下载并检查" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:text-fg disabled:opacity-50">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : null}
        <button type="button" onClick={() => setShowSource((value) => !value)} className="min-h-8 rounded-md px-1.5 text-xs text-muted hover:text-fg">
          {showSource ? "收起" : "源码"}
        </button>
        <button type="button" disabled={busy} onClick={onRemove} aria-label={`卸下 ${mod.name}`} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:text-danger disabled:opacity-50">
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      {origin || stamp ? (
        <p className="mt-1 truncate font-mono text-[11px] text-muted" title={mod.source}>
          {origin}
          {origin && stamp ? " · " : ""}
          {stamp}
        </p>
      ) : null}
      {shown.length ? (
        <p className="mt-1.5 flex flex-wrap gap-1">
          {shown.map((fn) => (
            <span key={fn} className="rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[11px] text-muted">
              {fn}
            </span>
          ))}
          {more > 0 ? <span className="px-1 py-0.5 font-mono text-[11px] text-muted">+{more}</span> : null}
        </p>
      ) : (
        <p className="mt-1 text-xs text-muted">没有顶层函数，只有类型或值。</p>
      )}
      {showSource ? <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-bg px-2.5 py-2 font-mono text-[11px] leading-5 text-fg">{mod.body}</pre> : null}
    </li>
  );
}
