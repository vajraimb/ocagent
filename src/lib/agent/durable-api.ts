import { createMiddleware, createServerFn } from "@tanstack/react-start";
import { readCreate, readDecision, readResume, readRunId, type DurableResponse } from "./durable-types";

const durableMiddleware = createMiddleware({ type: "function" })
  .client(async ({ next }) => {
    const { getBearerToken } = await import("@/lib/auth/client");
    return next({ sendContext: { bearerToken: getBearerToken() ?? undefined } });
  })
  .server(async ({ next, context }) => {
    const { assertSameSiteRequest } = await import("@/lib/auth/isolation.server");
    assertSameSiteRequest();
    const { resolveDurableOwner } = await import("./durable.server");
    const owner = await resolveDurableOwner(context.bearerToken);
    return next({ context: { owner } });
  });

async function gateway(op: string, fields: Record<string, unknown>, owner: string): Promise<DurableResponse> {
  const { callGateway } = await import("./durable.server");
  return callGateway(op, fields, owner);
}

export const createDurableRun = createServerFn({ method: "POST" })
  .middleware([durableMiddleware])
  .validator((input: unknown) => {
    const parsed = readCreate(input);
    if ("error" in parsed) throw new Error(parsed.error);
    return parsed;
  })
  .handler(async ({ data, context }): Promise<DurableResponse> => {
    return gateway("createRun", { dedupe_key: data.dedupeKey, material: data.material, task: data.task }, context.owner);
  });

export const listDurableRuns = createServerFn({ method: "POST" })
  .middleware([durableMiddleware])
  .validator((input: unknown) => input ?? {})
  .handler(async ({ context }): Promise<DurableResponse> => gateway("listRuns", {}, context.owner));

export const getDurableRun = createServerFn({ method: "POST" })
  .middleware([durableMiddleware])
  .validator((input: unknown) => {
    const parsed = readRunId(input);
    if ("error" in parsed) throw new Error(parsed.error);
    return parsed;
  })
  .handler(async ({ data, context }): Promise<DurableResponse> => gateway("getRun", { run_id: data.runId }, context.owner));

export const generateDurableRun = createServerFn({ method: "POST" })
  .middleware([durableMiddleware])
  .validator((input: unknown) => {
    const parsed = readRunId(input);
    if ("error" in parsed) throw new Error(parsed.error);
    return parsed;
  })
  .handler(async ({ data, context }): Promise<DurableResponse> => {
    const { generateAndAdmit } = await import("./durable.server");
    return generateAndAdmit(data.runId, context.owner);
  });

export const prepareDurableRun = createServerFn({ method: "POST" })
  .middleware([durableMiddleware])
  .validator((input: unknown) => {
    const parsed = readRunId(input);
    if ("error" in parsed) throw new Error(parsed.error);
    return parsed;
  })
  .handler(async ({ data, context }): Promise<DurableResponse> => gateway("prepareRun", { run_id: data.runId }, context.owner));

export const resumeDurableRun = createServerFn({ method: "POST" })
  .middleware([durableMiddleware])
  .validator((input: unknown) => {
    const parsed = readResume(input);
    if ("error" in parsed) throw new Error(parsed.error);
    return parsed;
  })
  .handler(async ({ data, context }): Promise<DurableResponse> =>
    gateway("startOrResumeRun", { run_id: data.runId, execution_hash: data.executionHash }, context.owner),
  );

export const decideDurableApproval = createServerFn({ method: "POST" })
  .middleware([durableMiddleware])
  .validator((input: unknown) => {
    const parsed = readDecision(input);
    if ("error" in parsed) throw new Error(parsed.error);
    return parsed;
  })
  .handler(async ({ data, context }): Promise<DurableResponse> =>
    gateway(
      "decideApproval",
      {
        run_id: data.runId,
        execution_hash: data.executionHash,
        seq: data.seq,
        request_hash: data.requestHash,
        callback_id: data.callbackId,
        decision: data.decision,
      },
      context.owner,
    ),
  );

