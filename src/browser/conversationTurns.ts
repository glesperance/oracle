import { CONVERSATION_TURN_CONTAINER_SELECTOR, CONVERSATION_TURN_SELECTOR } from "./constants.js";

/** Build a browser-context expression that returns one DOM node per conversation turn. */
export function buildConversationTurnListExpression(rootExpression = "document"): string {
  const containerSelector = JSON.stringify(CONVERSATION_TURN_CONTAINER_SELECTOR);
  const fallbackSelector = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  return `(() => {
    const root = ${rootExpression};
    const containers = Array.from(root.querySelectorAll(${containerSelector}));
    if (containers.length > 0) return containers;
    const legacyTurns = Array.from(root.querySelectorAll(${fallbackSelector}));
    if (legacyTurns.length > 0) return legacyTurns;
    // The current UI identifies message containers by search-unit keys instead
    // of conversation-turn test IDs. Do not mix both layouts and double-count.
    return Array.from(root.querySelectorAll('[data-chatgpt-search-unit-key]'));
  })()`;
}

export function buildConversationTurnCountExpression(rootExpression = "document"): string {
  return `(${buildConversationTurnListExpression(rootExpression)}).length`;
}
