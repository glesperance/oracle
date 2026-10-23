/**
 * Pure helpers for the claude.ai Research route: model-label parsing and
 * conversation-payload parsing. Browser/DOM side effects live in executor.ts.
 */

export const CLAUDE_RESEARCH_MODEL = "claude-research";
export const CLAUDE_DEFAULT_MODEL_LABEL = "Opus 5.5";
export const CLAUDE_DEFAULT_EFFORT = "High";
export const CLAUDE_EFFORTS = ["Low", "Medium", "High", "Extra", "Max"] as const;

export function isClaudeResearchModel(model: string | undefined | null): boolean {
  return typeof model === "string" && model.trim().toLowerCase() === CLAUDE_RESEARCH_MODEL;
}

export interface ClaudeModelTarget {
  model: string;
  effort: string;
}

/**
 * Parse a picker target like "Opus 5.5 High" or "Fable 5.1". The trailing word
 * is the effort when it names a known effort level; otherwise effort defaults.
 */
export function parseClaudeModelTarget(label: string | undefined | null): ClaudeModelTarget {
  const trimmed = (label ?? "").trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed.toLowerCase() === CLAUDE_RESEARCH_MODEL) {
    return { model: CLAUDE_DEFAULT_MODEL_LABEL, effort: CLAUDE_DEFAULT_EFFORT };
  }
  const words = trimmed.split(" ");
  const last = words[words.length - 1];
  const effort = CLAUDE_EFFORTS.find((e) => e.toLowerCase() === last.toLowerCase());
  if (effort && words.length > 1) {
    return { model: words.slice(0, -1).join(" "), effort };
  }
  return { model: trimmed, effort: CLAUDE_DEFAULT_EFFORT };
}

/** The picker button's aria-label reads "Model: <Model> <Effort>". */
export function pickerLabelMatches(ariaLabel: string | null | undefined, target: ClaudeModelTarget) {
  const normalized = (ariaLabel ?? "").replace(/^Model:\s*/i, "").trim().toLowerCase();
  return normalized === `${target.model} ${target.effort}`.toLowerCase();
}

interface ContentBlock {
  type?: string;
  name?: string;
  text?: string;
  input?: Record<string, unknown>;
  is_error?: boolean;
}

interface ChatMessage {
  uuid?: string;
  sender?: string;
  stop_reason?: string | null;
  content?: ContentBlock[];
}

export interface ClaudeConversationPayload {
  uuid?: string;
  model?: string;
  settings?: Record<string, unknown>;
  current_leaf_message_uuid?: string;
  chat_messages?: ChatMessage[];
}

export interface ClaudeResearchState {
  status: "waiting" | "researching" | "completed" | "failed";
  researchLaunched: boolean;
  summary: string;
  report: string | null;
  reportTitle: string | null;
  sources: Array<{ title: string; url: string }>;
  error?: string;
}

/**
 * Derive progress from claude.ai's conversation JSON. A research run is complete
 * when the leaf assistant message ended its turn after launching the extended
 * search task; the report is the markdown artifact it created.
 */
export function parseClaudeResearchState(payload: ClaudeConversationPayload): ClaudeResearchState {
  const messages = payload.chat_messages ?? [];
  const leaf =
    messages.find((m) => m.uuid && m.uuid === payload.current_leaf_message_uuid) ??
    messages[messages.length - 1];
  const empty: ClaudeResearchState = {
    status: "waiting",
    researchLaunched: false,
    summary: "",
    report: null,
    reportTitle: null,
    sources: [],
  };
  if (!leaf || leaf.sender !== "assistant") return empty;
  const blocks = leaf.content ?? [];
  const researchLaunched = blocks.some(
    (b) => b.type === "tool_use" && b.name === "launch_extended_search_task",
  );
  const researchError = blocks.find(
    (b) => b.type === "tool_result" && b.name === "launch_extended_search_task" && b.is_error,
  );
  const artifacts = blocks.filter(
    (b) => b.type === "tool_use" && b.name === "artifacts" && typeof b.input?.content === "string",
  );
  const artifact = artifacts[artifacts.length - 1];
  const launchIndex = blocks.findIndex(
    (b) => b.type === "tool_use" && b.name === "launch_extended_search_task",
  );
  const summary = blocks
    .slice(launchIndex >= 0 ? launchIndex : 0)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n\n")
    .trim();
  const sources: Array<{ title: string; url: string }> = [];
  const seen = new Set<string>();
  const citations = (artifact?.input?.md_citations as Array<Record<string, unknown>>) ?? [];
  for (const c of citations) {
    const url = typeof c.url === "string" ? c.url : null;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const meta = c.metadata as Record<string, unknown> | undefined;
    const title =
      (typeof meta?.preview_title === "string" && meta.preview_title) ||
      (typeof c.title === "string" && c.title) ||
      url;
    sources.push({ title, url });
  }
  const ended = leaf.stop_reason != null;
  let status: ClaudeResearchState["status"] = researchLaunched ? "researching" : "waiting";
  if (researchError) status = "failed";
  else if (ended && artifact) status = "completed";
  else if (ended && researchLaunched && launchIndex < blocks.length - 2) status = "completed";
  return {
    status,
    researchLaunched,
    summary,
    report: (artifact?.input?.content as string) ?? null,
    reportTitle: (artifact?.input?.title as string) ?? null,
    sources,
    error: researchError ? "Claude reported an error launching the research task." : undefined,
  };
}

export function formatClaudeResearchMarkdown(state: ClaudeResearchState): string {
  const parts: string[] = [];
  if (state.report) parts.push(state.report.trim());
  else if (state.summary) parts.push(state.summary);
  if (state.report && state.summary) {
    parts.push(`---\n\n## Chat summary\n\n${state.summary}`);
  }
  if (state.sources.length > 0) {
    parts.push(
      `## Sources\n\n${state.sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join("\n")}`,
    );
  }
  return parts.join("\n\n").trim();
}
