import { WEBSOCKET_ENDPOINT } from "../shared/constants";
import { toWebSocketUrl } from "../shared/settings";

const RULE_ID = 1;

/**
 * Chrome sends the server's (SameSite=Lax) session cookie with the extension's
 * fetch() calls but not with its websocket handshake, which the server then
 * redirects to /login. This session rule copies the cookie jar's cookies for
 * the server onto the handshake. It only matches /clipsocket requests that
 * don't come from a tab, i.e. the extension's own socket.
 */
export async function applyWebSocketCookieRule(serverUrl: string): Promise<void> {
  const cookies = await chrome.cookies.getAll({ url: serverUrl });
  const header = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [RULE_ID],
    addRules: header
      ? [
          {
            id: RULE_ID,
            priority: 1,
            action: {
              type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
              requestHeaders: [
                { header: "Cookie", operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: header },
              ],
            },
            condition: {
              urlFilter: `|${toWebSocketUrl(serverUrl, WEBSOCKET_ENDPOINT)}`,
              resourceTypes: [chrome.declarativeNetRequest.ResourceType.WEBSOCKET],
              tabIds: [chrome.tabs.TAB_ID_NONE],
            },
          },
        ]
      : [],
  });
}

export async function clearWebSocketCookieRule(): Promise<void> {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE_ID] });
}
