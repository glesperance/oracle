import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import type {
  BrowserLogger,
  BrowserRunOptions,
  BrowserRunResult,
  ChromeClient,
} from "../browser/types.js";
import type { BrowserModelSelectionEvidence } from "../sessionStore.js";
import { resolveBrowserConfig } from "../browser/config.js";
import {
  closeTab,
  connectWithNewTab,
  launchChrome,
  stopChromeGracefully,
} from "../browser/chromeLifecycle.js";
import { copyChromeProfile } from "../browser/profileCopy.js";
import { delay } from "../browser/utils.js";
import {
  formatClaudeResearchMarkdown,
  parseClaudeModelTarget,
  parseClaudeResearchState,
  pickerLabelMatches,
  type ClaudeConversationPayload,
  type ClaudeModelTarget,
} from "./research.js";

export const CLAUDE_NEW_CHAT_URL = "https://claude.ai/new";
const MIN_RESEARCH_TIMEOUT_MS = 60 * 60_000;
const POLL_INTERVAL_MS = 15_000;

const SEL = {
  composer: '[contenteditable="true"][aria-label="Write your prompt to Claude"]',
  composerFallback: "div.ProseMirror[contenteditable=true]",
  modelPicker: '[data-testid="model-selector-dropdown"]',
  attachMenu: '[data-testid="chat-input-attach"]',
  researchItem: '[data-testid="add-menu-research"]',
  researchPill:
    'button[aria-label="Research mode"]:not([aria-pressed="false"]), [role="button"][aria-label="Research mode"]:not([aria-pressed="false"]), button[aria-label="Research"][aria-pressed="true"]',
  send: '[data-testid="chat-input-send"]',
} as const;

export interface ClaudeWebExecutorOptions {
  /** Picker label like "Opus 5.5 High"; defaults to Opus 5.5 High. */
  modelLabel?: string;
}

export function createClaudeWebExecutor(
  options: ClaudeWebExecutorOptions = {},
): (runOptions: BrowserRunOptions) => Promise<BrowserRunResult> {
  return async (runOptions) => {
    const started = Date.now();
    const log: BrowserLogger = runOptions.log ?? ((() => {}) as BrowserLogger);
    const target = parseClaudeModelTarget(options.modelLabel);
    if ((runOptions.attachments ?? []).length > 0) {
      throw new Error(
        "claude-research does not upload files yet. Re-run with --browser-attachments never so files are pasted inline.",
      );
    }
    const config = runOptions.config ?? {};
    const sourceProfileRoot =
      config.copyProfileSource ??
      config.manualLoginProfileDir ??
      path.join(os.homedir(), ".oracle", "browser-profile");
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "oracle-claude-"));
    log(`[claude-web] Copying signed-in profile from ${sourceProfileRoot}`);
    const profileDirectory = await copyChromeProfile(
      sourceProfileRoot,
      tempRoot,
      // Without --copy-profile the CLI fills chromeProfile with "Default"; the
      // Oracle profile's signed-in session lives in Local State's last_used.
      config.copyProfileSource ? (config.chromeProfile ?? null) : null,
    );
    log(`[claude-web] Using Chrome profile directory "${profileDirectory}".`);
    const resolved = resolveBrowserConfig({
      ...config,
      headless: config.headless ?? true,
      manualLogin: false,
      keepBrowser: false,
      copyProfileSource: sourceProfileRoot,
      chromeProfile: profileDirectory,
    });
    const chrome = await launchChrome(resolved, tempRoot, log);
    let client: ChromeClient | undefined;
    let targetId: string | undefined;
    try {
      const conn = await connectWithNewTab(chrome.port, log, CLAUDE_NEW_CHAT_URL);
      client = conn.client;
      targetId = conn.targetId ?? undefined;
      const { Runtime, Input } = client;
      await Runtime.enable();
      const evaluate = async <T>(expression: string, awaitPromise = false): Promise<T> => {
        const { result, exceptionDetails } = await Runtime.evaluate({
          expression,
          returnByValue: true,
          awaitPromise,
        });
        if (exceptionDetails) {
          throw new Error(`claude.ai page script failed: ${exceptionDetails.text}`);
        }
        return result?.value as T;
      };
      const click = async (expr: string, label: string) => {
        const pt = await evaluate<[number, number] | null>(
          `(()=>{const e=${expr};if(!e)return null;e.scrollIntoView({block:'center'});const b=e.getBoundingClientRect();return [b.x+b.width/2,b.y+b.height/2]})()`,
        );
        if (!pt) throw new Error(`claude.ai control not found: ${label}`);
        await Input.dispatchMouseEvent({ type: "mouseMoved", x: pt[0], y: pt[1] });
        await delay(250);
        for (const type of ["mousePressed", "mouseReleased"] as const) {
          await Input.dispatchMouseEvent({
            type,
            x: pt[0],
            y: pt[1],
            button: "left",
            clickCount: 1,
          });
        }
        await delay(800);
      };
      const escape = async () => {
        await Input.dispatchKeyEvent({ type: "keyDown", key: "Escape", code: "Escape" });
        await Input.dispatchKeyEvent({ type: "keyUp", key: "Escape", code: "Escape" });
        await delay(400);
      };
      const q = (sel: string) => `document.querySelector(${JSON.stringify(sel)})`;
      const menuRow = (text: string) =>
        `[...document.querySelectorAll('[role^=menuitem]')].find(e=>e.innerText.trim().replace(/\\s+/g,' ').toLowerCase().startsWith(${JSON.stringify(text.toLowerCase())}))`;

      await waitForComposer(evaluate, resolved.inputTimeoutMs ?? 120_000, log);
      const modelSelection = await selectModel(
        target,
        { evaluate, click, escape, q, menuRow },
        log,
      );
      await enableResearch({ evaluate, click, escape, q }, log);

      const composer = `(${q(SEL.composer)}||${q(SEL.composerFallback)})`;
      await click(composer, "composer");
      await Input.insertText({ text: runOptions.prompt });
      await delay(800);
      const typed = await evaluate<number>(`${composer}.innerText.trim().length`);
      if (typed < Math.min(runOptions.prompt.trim().length, 20) * 0.9) {
        throw new Error(`Prompt did not land in the claude.ai composer (${typed} chars).`);
      }
      // Final gate right before send: model and Research must still be on.
      const research = await isResearchOn({ evaluate, click, escape, q });
      const picker = await readPicker({ evaluate, click, escape, q });
      if (!pickerLabelMatches(picker, target) || !research) {
        throw new Error(
          `claude.ai settings drifted before send (picker=${picker}, research=${research}).`,
        );
      }
      await click(q(SEL.send), "send button");

      let conversationUrl = "";
      for (let i = 0; i < 60 && !conversationUrl.includes("/chat/"); i += 1) {
        await delay(1_000);
        conversationUrl = await evaluate<string>("location.href");
      }
      if (!conversationUrl.includes("/chat/")) {
        throw new Error(
          "claude.ai did not open a conversation after send; prompt may not be submitted.",
        );
      }
      const conversationId = conversationUrl.split("/chat/")[1]?.split(/[?#/]/)[0] ?? "";
      log(`[claude-web] Submitted. Conversation: ${conversationUrl}`);
      await runOptions.runtimeHintCb?.(
        {
          chromePid: chrome.pid,
          chromePort: chrome.port,
          chromeTargetId: targetId,
          tabUrl: conversationUrl,
          conversationId,
          userDataDir: tempRoot,
          controllerPid: process.pid,
        },
        modelSelection,
      );

      const timeoutMs = Math.max(resolved.timeoutMs ?? 0, MIN_RESEARCH_TIMEOUT_MS);
      const deadline = Date.now() + timeoutMs;
      let lastStatus = "";
      while (Date.now() < deadline) {
        const payload = await fetchConversation(evaluate, conversationId);
        if (payload) {
          const state = parseClaudeResearchState(payload);
          if (state.status !== lastStatus) {
            log(`[claude-web] Research status: ${state.status}`);
            lastStatus = state.status;
          }
          if (state.status === "failed") throw new Error(state.error ?? "Claude research failed.");
          if (state.status === "completed") {
            const answerMarkdown = formatClaudeResearchMarkdown(state);
            log(
              `[claude-web] Research complete: ${state.reportTitle ?? "(no report title)"}, ${state.sources.length} sources.`,
            );
            return {
              answerText: answerMarkdown,
              answerMarkdown,
              modelSelection,
              tookMs: Date.now() - started,
              answerTokens: Math.ceil(answerMarkdown.length / 4),
              answerChars: answerMarkdown.length,
              browserTransport: "cdp",
              chromePid: chrome.pid,
              chromePort: chrome.port,
              chromeTargetId: targetId,
              tabUrl: conversationUrl,
              conversationId,
              promptSubmitted: true,
            };
          }
        }
        await delay(POLL_INTERVAL_MS);
      }
      throw new Error(
        `Claude research did not finish within ${Math.round(timeoutMs / 60_000)} min. The run continues at ${conversationUrl}; do not resubmit.`,
      );
    } finally {
      if (targetId) await closeTab(chrome.port, targetId, log).catch(() => undefined);
      await client?.close().catch(() => undefined);
      await stopChromeGracefully(chrome, { logger: log }).catch(() => undefined);
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

type Evaluate = <T>(expression: string, awaitPromise?: boolean) => Promise<T>;

async function waitForComposer(evaluate: Evaluate, timeoutMs: number, log: BrowserLogger) {
  const deadline = Date.now() + Math.max(timeoutMs, 30_000);
  let noted = false;
  while (Date.now() < deadline) {
    const state = await evaluate<{ url: string; title: string; ready: boolean }>(
      `({url:location.href,title:document.title,ready:!!document.querySelector(${JSON.stringify(SEL.modelPicker)})&&!!document.querySelector('[contenteditable=true]')})`,
    ).catch(() => ({ url: "", title: "", ready: false }));
    if (state.ready) return;
    if (state.url.includes("/login")) {
      throw new Error(
        "claude.ai is signed out in the Oracle profile. Sign in once in a visible Chrome on ~/.oracle/browser-profile, then retry.",
      );
    }
    if (!noted && /just a moment/i.test(state.title)) {
      log("[claude-web] Cloudflare check in progress; waiting...");
      noted = true;
    }
    await delay(1_000);
  }
  throw new Error(
    "Timed out waiting for the claude.ai composer (Cloudflare challenge or UI change).",
  );
}

interface Ui {
  evaluate: Evaluate;
  click: (expr: string, label: string) => Promise<void>;
  escape: () => Promise<void>;
  q: (sel: string) => string;
  menuRow?: (text: string) => string;
}

async function readPicker(ui: Ui): Promise<string | null> {
  return ui.evaluate<string | null>(`${ui.q(SEL.modelPicker)}?.getAttribute('aria-label')??null`);
}

async function selectModel(
  target: ClaudeModelTarget,
  ui: Required<Ui>,
  log: BrowserLogger,
): Promise<BrowserModelSelectionEvidence> {
  const requested = `${target.model} ${target.effort}`;
  const before = await readPicker(ui);
  if (pickerLabelMatches(before, target)) {
    log(`[claude-web] Model already ${requested}.`);
    return evidence(requested, before, "already-selected");
  }
  await ui.click(ui.q(SEL.modelPicker), "model picker");
  await ui.click(ui.menuRow(target.model), `model row "${target.model}"`);
  await ui.click(ui.q(SEL.modelPicker), "model picker");
  await ui.click(ui.menuRow("Effort"), "effort submenu");
  await ui.click(ui.menuRow(target.effort), `effort "${target.effort}"`);
  await ui.escape();
  const after = await readPicker(ui);
  if (!pickerLabelMatches(after, target)) {
    throw new Error(`claude.ai model picker shows "${after}", expected "Model: ${requested}".`);
  }
  log(`[claude-web] Model set: ${after}`);
  return evidence(requested, after, "switched");
}

function evidence(
  requested: string,
  label: string | null,
  status: BrowserModelSelectionEvidence["status"],
): BrowserModelSelectionEvidence {
  return {
    requestedModel: requested,
    resolvedLabel: label?.replace(/^Model:\s*/i, "") ?? null,
    strategy: "select",
    status,
    verified: true,
    source: "claude-model-picker",
    capturedAt: new Date().toISOString(),
  };
}

async function readResearchChecked(ui: Ui): Promise<string | null> {
  return ui.evaluate<string | null>(
    `${ui.q(SEL.researchItem)}?.getAttribute('aria-checked')??null`,
  );
}

async function isResearchOn(ui: Ui): Promise<boolean> {
  // An open menu is authoritative, including an explicit unchecked state.
  const checked = await readResearchChecked(ui);
  if (checked !== null) {
    await ui.escape();
    return checked === "true";
  }
  if (await ui.evaluate<boolean>(`!!${ui.q(SEL.researchPill)}`)) return true;
  // The composer indicator can be absent while Research is enabled. Reopen the
  // menu to read state rather than clicking the toggle again and turning it off.
  await ui.click(ui.q(SEL.attachMenu), "+ menu");
  try {
    return (await readResearchChecked(ui)) === "true";
  } finally {
    await ui.escape();
  }
}

async function enableResearch(ui: Ui, log: BrowserLogger) {
  if (await isResearchOn(ui)) {
    await ui.escape();
    log("[claude-web] Research already on.");
    return;
  }
  await ui.click(ui.q(SEL.attachMenu), "+ menu");
  try {
    const checked = await readResearchChecked(ui);
    if (checked === null) throw new Error("claude.ai + menu has no Research item.");
    if (checked !== "true") await ui.click(ui.q(SEL.researchItem), "Research item");
  } finally {
    await ui.escape();
  }
  const deadline = Date.now() + 5_000;
  do {
    if (await isResearchOn(ui)) {
      log("[claude-web] Research on.");
      return;
    }
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error("Research mode did not turn on in claude.ai.");
}

async function fetchConversation(
  evaluate: Evaluate,
  conversationId: string,
): Promise<ClaudeConversationPayload | null> {
  const raw = await evaluate<string | null>(
    `(async()=>{const id=${JSON.stringify(conversationId)};
      const orgs=await (await fetch('/api/organizations')).json();
      for(const o of orgs){const r=await fetch('/api/organizations/'+o.uuid+'/chat_conversations/'+id+'?tree=True&rendering_mode=messages&render_all_tools=true');
        if(r.ok) return await r.text();}
      return null})()`,
    true,
  ).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ClaudeConversationPayload;
  } catch {
    return null;
  }
}
