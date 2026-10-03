import type { Eff, Json } from "./types.ts";

export function canonical(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortValue(source[key]);
    return out;
  }
  return value;
}

export function fnv(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5 ^ 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ (code + i), 0x01000193);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

export function effectLabel(eff: Eff): string {
  switch (eff.tag) {
    case "Llm":
      return `Llm · ${eff.request.purpose}`;
    case "Tool":
      return `Tool · ${eff.call.name}`;
    case "AskHuman":
      return `Ask_human · ${eff.approval.action}`;
    case "Checkpoint":
      return `Checkpoint · ${eff.label}`;
    case "Compact":
      return "Compact";
    case "Now":
      return "Now";
    case "FreshId":
      return "Fresh_id";
  }
}

export function effectReq(eff: Eff): Json {
  switch (eff.tag) {
    case "Llm":
      return {
        purpose: eff.request.purpose,
        messages: eff.request.messages.map((msg) => ({ role: msg.role, content: msg.content })),
      };
    case "Tool":
      return { callId: eff.call.callId, name: eff.call.name, args: eff.call.args };
    case "AskHuman":
      return {
        action: eff.approval.action,
        risk: eff.approval.risk,
        payload: eff.approval.payload,
      };
    case "Checkpoint":
      return { label: eff.label };
    case "Compact":
      return { messages: eff.msgs.map((msg) => ({ role: msg.role, content: msg.content })) };
    case "Now":
    case "FreshId":
      return {};
  }
}

export function reqHash(eff: Eff): string {
  return fnv(canonical({ tag: eff.tag, req: effectReq(eff) }));
}
