import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  ChatMetadataParams,
  CommandsListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogResult } from "../../api/types.ts";
import { invalidateModelCatalogCache, type ModelCatalogReadScope } from "../model-catalog-cache.ts";
import {
  hasUiSessionDefaults,
  parseAgentSessionKey,
  resolveUiConversationIdentity,
  type UiSessionDefaultsHost,
} from "../sessions/session-key.ts";

export type ChatMetadataResult = CommandsListResult;

export type ChatMetadataUpdate =
  | { type: "invalidated"; refreshSessionFacts: boolean }
  | { type: "loading" }
  | { type: "result"; result: ChatMetadataResult }
  | { type: "error"; error: unknown };
export type ChatMetadataPublication = {
  isCurrent: () => boolean;
  publish: (
    result: ChatMetadataResult & { models?: unknown; accountSelection?: unknown },
  ) => ChatMetadataResult;
  fail: (error: unknown) => void;
};
export type ChatMetadataRequest = {
  promise: Promise<ChatMetadataResult>;
  publication: ChatMetadataPublication;
  revalidation: boolean;
  setStartupRetryDeadline: (deadlineAt?: number) => void;
  start: () => void;
};
export type ChatMetadataRefresh = {
  catalog: Promise<ModelCatalogResult | undefined>;
  completed: Promise<void>;
  isCurrent: () => boolean;
};
export type ChatMetadataRefreshRecord = ChatMetadataRefresh & {
  phase: "waiting" | "admitted" | "inactive";
  revision: number;
  catalogRevision: number;
  metadataRequired: boolean;
  revalidateMetadata?: () => boolean;
  start: () => void;
};
export type ChatMetadataEntry = {
  scope: ChatMetadataParams;
  result?: ChatMetadataResult;
  activeRequest?: ChatMetadataRequest;
  queuedRequest?: ChatMetadataRequest;
  writer?: object;
  refreshRevision: number;
  catalogRevision: number;
  refresh?: ChatMetadataRefreshRecord;
  listeners: Map<(update: ChatMetadataUpdate) => void, () => boolean>;
  release: () => void;
};

export const chatMetadataCache = new WeakMap<
  GatewayBrowserClient,
  {
    entries: Map<string, ChatMetadataEntry>;
    invalidate: (scope?: ChatMetadataParams, sessionDefaults?: UiSessionDefaultsHost) => void;
    invalidateSession: (
      source: Record<string, unknown> | null,
      sessionDefaults: UiSessionDefaultsHost,
    ) => void;
  }
>();

export function invalidateChatMetadataStore(
  client: GatewayBrowserClient,
  scope?: ChatMetadataParams,
  sessionDefaults?: UiSessionDefaultsHost,
): void {
  // Catalog readers share this lifecycle; retire their copies before metadata listeners reload.
  invalidateModelCatalogCache(
    client,
    sessionDefaults && scope?.sessionKey ? { agentId: scope.agentId, sessionsOnly: true } : scope,
  );
  chatMetadataCache.get(client)?.invalidate(scope, sessionDefaults);
}

export function invalidateChatMetadataForSessionEvent(
  client: GatewayBrowserClient,
  payload: unknown,
  sessionDefaults: UiSessionDefaultsHost,
): void {
  const source = asNullableRecord(payload);
  const agentId = typeof source?.agentId === "string" ? source.agentId : undefined;
  const messageKey =
    source?.phase === "message" &&
    source.reason === undefined &&
    typeof source.sessionKey === "string"
      ? canonicalCatalogSessionKey({ agentId, sessionKey: source.sessionKey }, sessionDefaults)
      : undefined;
  // Transcript notifications do not advance the server's session mutation fence.
  // RPC mutations and ambiguous identities still retire every affected agent scope.
  invalidateModelCatalogCache(client, {
    agentId,
    sessionsOnly: true,
    ...(messageKey
      ? {
          matchesScope: (candidate: ModelCatalogReadScope) => {
            const candidateKey = canonicalCatalogSessionKey(candidate, sessionDefaults);
            return !candidateKey || candidateKey === messageKey;
          },
        }
      : {}),
  });
  chatMetadataCache.get(client)?.invalidateSession(source, sessionDefaults);
}

function canonicalCatalogSessionKey(
  scope: ModelCatalogReadScope,
  defaults: UiSessionDefaultsHost,
): string | undefined {
  if (!hasUiSessionDefaults(defaults) || !scope.agentId || !scope.sessionKey) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(scope.sessionKey);
  if (
    !parsed ||
    parsed.agentId !== scope.agentId ||
    scope.sessionKey !== `agent:${parsed.agentId}:${parsed.rest}`
  ) {
    return undefined;
  }
  const canonical = resolveUiConversationIdentity(defaults, scope.sessionKey, scope.agentId);
  return canonical.sessionKey === scope.sessionKey ? scope.sessionKey : undefined;
}
