import type { ToolStep } from "./workspace.ts";

type SearchCall = {
  type?: string;
  action?: { query?: string; sources?: { url?: string }[] };
  content?: { text?: string }[];
};

const IO = new Set(["web_search", "http_get"]);

export function orderCalls<T extends { name?: string }>(calls: T[]): T[] {
  const rank = (name?: string) => (name === "ocaml_run" ? 2 : IO.has(name ?? "") ? 0 : 1);
  return [...calls].sort((left, right) => rank(left.name) - rank(right.name));
}

export function callsThisRound<T extends { name?: string }>(calls: T[]): { run: T[]; defer: T[] } {
  const io = calls.filter((call) => IO.has(call.name ?? ""));
  if (io.length === 0) return { run: calls, defer: [] };
  return { run: io, defer: calls.filter((call) => !IO.has(call.name ?? "")) };
}

export function webSearchSteps(output: unknown): ToolStep[] {
  if (!Array.isArray(output)) return [];
  const steps: ToolStep[] = [];
  for (const item of output as SearchCall[]) {
    if (!item || item.type !== "web_search_call") continue;
    const query = item.action?.query?.trim() || "网上";
    const urls = [
      ...new Set(
        (item.action?.sources ?? [])
          .map((source) => source.url?.trim() ?? "")
          .filter((url) => url.startsWith("http://") || url.startsWith("https://")),
      ),
    ].slice(0, 4);
    steps.push({ tool: "web_search", detail: query.slice(0, 80), output: urls.join("\n") || "已搜索" });
  }
  return steps;
}

export async function searchWeb(apiKey: string, query: string): Promise<string> {
  try {
    const response = await fetch("https://api.x.ai/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(12_000),
      body: JSON.stringify({
        model: "grok-4.5",
        reasoning: { effort: "low" },
        max_output_tokens: 350,
        input: `Search the web and answer briefly in plain text, then list source URLs. Query: ${query}`,
        tools: [{ type: "web_search" }],
      }),
    });
    if (!response.ok) return `搜索没接上（${response.status}）。按已经知道的公开接口写，不要再搜。`;
    const body = (await response.json()) as { output?: SearchCall[] };
    const text = (body.output ?? [])
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content ?? [])
      .map((part) => part.text ?? "")
      .join("\n")
      .replaceAll("**", "")
      .replace(/\[\[\d+\]\]\([^)]*\)/g, "")
      .trim();
    const urls = webSearchSteps(body.output)
      .map((step) => step.output)
      .join("\n");
    const joined = [text, urls].filter(Boolean).join("\n").slice(0, 1500);
    return joined || "网上没有查到。按已经知道的公开接口写。";
  } catch {
    return "搜索超时了。按已经知道的公开接口写，不要再搜。";
  }
}
