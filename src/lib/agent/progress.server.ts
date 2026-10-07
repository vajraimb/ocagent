import { ProgressRegistry } from "./progress.ts";
import type { DeskResult } from "./run.ts";

// One registry per server process. The dev server and a long-lived Node host
// share it between the run and the page polling it; a per-request host simply
// reports the job as not found and the page falls back to the final answer.
const globalScope = globalThis as typeof globalThis & { __ocagentProgress?: ProgressRegistry<DeskResult> };

export const deskProgress: ProgressRegistry<DeskResult> = globalScope.__ocagentProgress ?? (globalScope.__ocagentProgress = new ProgressRegistry<DeskResult>());
