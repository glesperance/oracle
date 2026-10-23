import { describe, expect, test } from "vitest";
import {
  formatClaudeResearchMarkdown,
  parseClaudeModelTarget,
  parseClaudeResearchState,
  pickerLabelMatches,
} from "../../src/claude-web/research.js";

const human = { uuid: "h", sender: "human", content: [{ type: "text", text: "q" }] };
const launch = { type: "tool_use", name: "launch_extended_search_task", input: { command: "q" } };

describe("claude-web model target", () => {
  test("defaults to Opus 5.5 High", () => {
    expect(parseClaudeModelTarget(undefined)).toEqual({ model: "Opus 5.5", effort: "High" });
    expect(parseClaudeModelTarget("claude-research")).toEqual({ model: "Opus 5.5", effort: "High" });
  });
  test("parses trailing effort", () => {
    expect(parseClaudeModelTarget("Fable 5.1 Max")).toEqual({ model: "Fable 5.1", effort: "Max" });
    expect(parseClaudeModelTarget("Sonnet 5.5")).toEqual({ model: "Sonnet 5.5", effort: "High" });
  });
  test("matches picker aria-label exactly", () => {
    const t = { model: "Opus 5.5", effort: "High" };
    expect(pickerLabelMatches("Model: Opus 5.5 High", t)).toBe(true);
    expect(pickerLabelMatches("Model: Opus 5.5 Medium", t)).toBe(false);
    expect(pickerLabelMatches("Model: Fable 5.1 High", t)).toBe(false);
  });
});

describe("claude-web research state", () => {
  test("waiting before the assistant replies", () => {
    expect(parseClaudeResearchState({ chat_messages: [human] }).status).toBe("waiting");
  });
  test("researching while the leaf turn is open", () => {
    const a = { uuid: "a", sender: "assistant", stop_reason: null, content: [{ type: "text", text: "ok" }, launch] };
    const s = parseClaudeResearchState({ current_leaf_message_uuid: "a", chat_messages: [human, a] });
    expect(s.status).toBe("researching");
  });
  test("completed with artifact report and deduped sources", () => {
    const a = {
      uuid: "a",
      sender: "assistant",
      stop_reason: "end_turn",
      content: [
        { type: "text", text: "Starting." },
        launch,
        { type: "tool_result", name: "launch_extended_search_task", is_error: false },
        { type: "text", text: "Pick Nango." },
        {
          type: "tool_use",
          name: "artifacts",
          input: {
            title: "Report",
            content: "# Report\n\nBody",
            md_citations: [
              { url: "https://a.example", title: "a", metadata: { preview_title: "A page" } },
              { url: "https://a.example", title: "a" },
              { url: "https://b.example", title: "b" },
            ],
          },
        },
        { type: "tool_result", name: "artifacts" },
      ],
    };
    const s = parseClaudeResearchState({ current_leaf_message_uuid: "a", chat_messages: [human, a] });
    expect(s.status).toBe("completed");
    expect(s.report).toContain("# Report");
    expect(s.sources).toEqual([
      { title: "A page", url: "https://a.example" },
      { title: "b", url: "https://b.example" },
    ]);
    const md = formatClaudeResearchMarkdown(s);
    expect(md.startsWith("# Report")).toBe(true);
    expect(md).toContain("Pick Nango.");
    expect(md).toContain("2. [b](https://b.example)");
  });
  test("failed when the research tool errors", () => {
    const a = {
      uuid: "a",
      sender: "assistant",
      stop_reason: "end_turn",
      content: [launch, { type: "tool_result", name: "launch_extended_search_task", is_error: true }],
    };
    expect(parseClaudeResearchState({ chat_messages: [human, a] }).status).toBe("failed");
  });
});
