import { FileText, X } from "lucide-react";
import { CATALOG, type DeskModule, type HarnessId } from "@/lib/agent/harness";
import type { DeskFile } from "@/lib/agent/workspace";

const FIXED: HarnessId[] = ["ocaml"];

export function SidePanel({
  harnesses,
  setHarnesses,
  modules,
  setModules,
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
  files: DeskFile[];
  selected: string;
  onSelect: (path: string) => void;
  onReset: () => void;
  onClose?: () => void;
  busy: boolean;
}) {
  const file = files.find((item) => item.path === selected) ?? null;
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

      {modules.length > 0 ? (
        <section className="px-4 pb-4">
          <h2 className="text-sm font-medium text-fg">已加载的 module</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {modules.map((mod) => (
              <button
                key={mod.name}
                type="button"
                disabled={busy}
                onClick={() => setModules(modules.filter((item) => item.name !== mod.name))}
                title="点一下卸下"
                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border bg-bg px-2.5 font-mono text-xs text-fg hover:border-danger hover:text-danger disabled:opacity-50"
              >
                {mod.name}
                <X className="h-3 w-3" aria-hidden />
              </button>
            ))}
          </div>
        </section>
      ) : null}

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
        {file ? <pre className="mt-2 max-h-72 overflow-auto rounded-lg border border-border bg-bg px-3 py-2 font-mono text-xs leading-5 text-fg">{file.content}</pre> : null}
      </section>

      <div className="mt-auto border-t border-border px-4 py-3">
        <button type="button" onClick={onReset} disabled={busy} className="min-h-10 rounded-lg px-2 text-xs text-muted hover:text-danger disabled:opacity-50">
          清空对话和文件
        </button>
      </div>
    </div>
  );
}
