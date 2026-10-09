import { ProgressRegistry } from "./progress.ts";
import type { RunReply } from "./run.ts";

// One registry per server process: the fast path for a page polling the same
// instance that runs its task. The run's row in the database is the slow path
// (and the durable record) for every other instance.
const globalScope = globalThis as typeof globalThis & { __ocagentRuns?: ProgressRegistry<RunReply> };

export const runProgress: ProgressRegistry<RunReply> = globalScope.__ocagentRuns ?? (globalScope.__ocagentRuns = new ProgressRegistry<RunReply>());
