import { useState } from "react";
import { Blocks, FileText, LoaderCircle, X } from "lucide-react";
import { CATALOG, MAX_MODULES, moduleExports, moduleNameFor, type DeskModule, type HarnessId } from "@/lib/agent/harness";
import type { DeskFile } from "@/lib/agent/workspace";

const FIXED: HarnessId[] = ["ocaml"];

export function SidePanel({
  harnesses,
  setHarnesses,
  modules,
  setModules,
  onInstall,
  files,
  selected,
  onSelect,
  onReset,
  onClose,
  busy,
}: {
  harnesses: HarnessId[];
  setHarnesses: (next: HarnessId[]) => void;
  modules: DeskModule[];
  setModules: (next: DeskModule[]) => void;
  onInstall: (file: DeskFile) => Promise<string | null>;
  files: DeskFile[];
  selected: string;
  onSelect: (path: string) => void;
  onReset: () => void;
  onClose?: () => void;
  busy: boolean;
}) {
  const file = files.find((item) => item.path === selected) ?? null;
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<{ path: string; text: string } | null>(null);
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
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <p className="font-mono text-xs tracking-widest text-muted">工作区</p>
        {onClose ? (
          <button type="button" onClick={onClose} aria-label="收起工作区" className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:text-fg">
            <X className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
      </div>

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
        {modules.length === 0 ? <p className="mt-2 text-xs leading-5 text-muted">还没有。它写好一个 .ml 后可以自己装上，或者你在下面的文件里点“装为 harness”。装上以后，每一步都能直接调用。</p> : null}
        {modules.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-2">
            {modules.map((mod) => (
              <ModuleCard key={mod.name} mod={mod} busy={busy} onRemove={() => setModules(modules.filter((item) => item.name !== mod.name))} />
            ))}
          </ul>
        ) : null}
      </section>

      <section className="flex min-h-0 flex-1 flex-col px-4 pb-4">
        <h2 className="text-sm font-medium text-fg">
          文件
          {files.length ? <span className="ml-1.5 font-mono text-xs text-muted">{files.length}</span> : null}
        </h2>
        {files.length === 0 ? <p className="mt-2 text-xs leading-5 text-muted">还没有文件。让它写一个，这里就会出现。</p> : null}
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
                    <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />
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
                  disabled={busy || installing || alreadyLoaded}
                  onClick={() => void install(file)}
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border bg-bg px-2.5 text-xs text-fg hover:border-accent hover:text-accent disabled:opacity-50 disabled:hover:border-border disabled:hover:text-fg"
                >
                  {installing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Blocks className="h-3.5 w-3.5" aria-hidden />}
                  {alreadyLoaded ? `${candidate} 已装上` : installing ? "编译检查中" : `装为 harness ${candidate}`}
                </button>
                {installError?.path === file.path ? <p className="min-w-0 flex-1 text-xs leading-5 text-danger">{installError.text}</p> : null}
              </div>
            ) : null}
            <pre className="max-h-72 overflow-auto rounded-lg border border-border bg-bg px-3 py-2 font-mono text-xs leading-5 text-fg">{file.content}</pre>
          </div>
        ) : null}
      </section>

      <div className="mt-auto border-t border-border px-4 py-3">
        <button type="button" onClick={onReset} disabled={busy} className="min-h-10 rounded-lg px-2 text-xs text-muted hover:text-danger disabled:opacity-50">
          清空对话和文件
        </button>
      </div>
    </div>
  );
}

function ModuleCard({ mod, busy, onRemove }: { mod: DeskModule; busy: boolean; onRemove: () => void }) {
  const [showSource, setShowSource] = useState(false);
  const exports = moduleExports(mod.body);
  const shown = exports.slice(0, 8);
  const more = exports.length - shown.length;
  return (
    <li className="rounded-lg border border-border bg-surface px-3 py-2">
      <div className="flex items-center gap-2">
        <Blocks className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg">{mod.name}</span>
        <button type="button" onClick={() => setShowSource((value) => !value)} className="min-h-8 rounded-md px-1.5 text-xs text-muted hover:text-fg">
          {showSource ? "收起" : "源码"}
        </button>
        <button type="button" disabled={busy} onClick={onRemove} aria-label={`卸下 ${mod.name}`} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:text-danger disabled:opacity-50">
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
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
