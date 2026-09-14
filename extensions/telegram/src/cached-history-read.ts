import {
  readPositiveIntegerParam,
  readStringOrNumberParam,
} from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveTelegramDmAllow } from "./access-groups.js";
import { resolveTelegramAccountOwnerAgentId } from "./account-owner.js";
import { listTelegramAccountIds, mergeTelegramAccountConfig } from "./accounts.js";
import { resolveTelegramEffectiveDmPolicy } from "./bot-access.js";
import { readCachedTelegramBotInfo } from "./bot-info-cache.js";
import { resolveTelegramGroupAllowFromContext } from "./bot/helpers.js";
import { selectAllowedTelegramGroupContext } from "./cached-group-context.js";
import { isTelegramDmAccessAllowed } from "./dm-access.js";
import { evaluateTelegramGroupBaseAccess } from "./group-access.js";
import { resolveTelegramScopedGroupConfig } from "./group-config-helpers.js";
import { resolveTelegramMessageCacheScope } from "./message-cache-persistence.js";
import {
  createTelegramMessageCache,
  isTelegramSessionBoundaryCommandNode,
  resolveProviderObservedTelegramThreadSpec,
  type TelegramCachedMessageNode,
} from "./message-cache.js";
import {
  resolveTelegramCachedHistoryScope,
  type TelegramMessageMutationContext,
} from "./message-topic-binding.js";
import { resolveTelegramToken } from "./token.js";

const MAX_MESSAGES = 100;
// UTF-8 bytes bound even adversarial high-token-density text, not just message count.
const MAX_RESULT_BYTES = 32 * 1024;
const SCAN_LIMIT = 3000;

type SafeMessage = Pick<
  TelegramCachedMessageNode,
  | "messageId"
  | "sender"
  | "senderId"
  | "senderUsername"
  | "timestamp"
  | "body"
  | "mediaType"
  | "mediaRef"
  | "replyToId"
  | "threadId"
> & { truncated?: true };

function projectMessage(node: TelegramCachedMessageNode): SafeMessage {
  const {
    messageId,
    sender,
    senderId,
    senderUsername,
    timestamp,
    body,
    mediaType,
    mediaRef,
    replyToId,
    threadId,
  } = node;
  return {
    messageId,
    sender,
    senderId,
    senderUsername,
    timestamp,
    body,
    mediaType,
    mediaRef,
    replyToId,
    threadId,
  };
}

async function isSourceAllowed(params: {
  cfg: OpenClawConfig;
  accountId: string;
  chatId: string;
  threadId?: number;
  node: TelegramCachedMessageNode;
  botId?: number;
  botUsername?: string;
}): Promise<boolean> {
  const { cfg, accountId, chatId, threadId, node } = params;
  const msg = node.sourceMessage;
  if (String(msg.chat?.id) !== chatId || !msg.from?.id) {
    return false;
  }
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  // Channel posts and business direct-message topics need their own admission contract.
  if (!isGroup && msg.chat.type !== "private") {
    return false;
  }
  const observed = resolveProviderObservedTelegramThreadSpec(node);
  if (
    threadId !== undefined
      ? observed?.id !== threadId || observed.scope !== (isGroup ? "forum" : "dm")
      : node.threadId !== undefined || observed !== undefined
  ) {
    return false;
  }
  const telegramCfg = mergeTelegramAccountConfig(cfg, accountId);
  const senderId = String(msg.from.id);
  const context = await resolveTelegramGroupAllowFromContext({
    cfg,
    accountId,
    chatId,
    senderId,
    isGroup,
    threadSpec: isGroup ? { scope: "forum", id: threadId } : { scope: "dm", id: threadId },
    dmPolicy: telegramCfg.dmPolicy,
    allowFrom: telegramCfg.allowFrom,
    groupAllowFrom: telegramCfg.groupAllowFrom ?? telegramCfg.allowFrom,
    resolveTelegramGroupConfig: (id, topic) =>
      resolveTelegramScopedGroupConfig(telegramCfg, id, topic),
  });
  if (
    !evaluateTelegramGroupBaseAccess({
      ...context,
      isGroup,
      senderId,
      enforceAllowOverride: !isGroup,
      requireSenderForAllowOverride: true,
    }).allowed
  ) {
    return false;
  }
  if (isGroup) {
    return (
      await selectAllowedTelegramGroupContext({
        cfg,
        telegramCfg,
        accountId,
        chatId,
        threadId,
        nodes: [node],
        botId: params.botId,
        botUsername: params.botUsername,
      })
    ).has(node.messageId);
  }
  const dmPolicy = resolveTelegramEffectiveDmPolicy({
    isGroup,
    groupConfig: context.groupConfig,
    dmPolicy: telegramCfg.dmPolicy,
  });
  const dmAllow = await resolveTelegramDmAllow({
    cfg,
    accountId,
    senderId,
    dmPolicy,
    allowFrom: telegramCfg.allowFrom,
    groupAllowOverride: context.groupAllowOverride,
    storeAllowFrom: context.storeAllowFrom,
  });
  return isTelegramDmAccessAllowed({
    accountId,
    dmPolicy,
    msg,
    chatId: Number(chatId),
    effectiveDmAllow: dmAllow.effectiveAllow,
  });
}

export async function readTelegramCachedHistory(input: {
  params: Record<string, unknown>;
  cfg: OpenClawConfig;
  accountId?: string | null;
  context?: TelegramMessageMutationContext;
}) {
  const { params, cfg, context } = input;
  const scope = resolveTelegramCachedHistoryScope({
    cfg,
    accountId: input.accountId,
    context,
    chatId:
      readStringOrNumberParam(params, "chatId") ??
      readStringOrNumberParam(params, "channelId") ??
      readStringOrNumberParam(params, "to"),
    threadId:
      readPositiveIntegerParam(params, "threadId") ??
      readPositiveIntegerParam(params, "messageThreadId"),
  });
  if (
    !listTelegramAccountIds(cfg).includes(scope.accountId) ||
    cfg.channels?.telegram?.enabled === false ||
    mergeTelegramAccountConfig(cfg, scope.accountId).enabled === false
  ) {
    throw new Error("Telegram cached history account is unavailable.");
  }
  const currentId = parseStrictPositiveInteger(context?.toolContext?.currentMessageId);
  const before = readPositiveIntegerParam(params, "before") ?? currentId;
  if (
    before === undefined ||
    (context?.conversationReadOrigin === "delegated" &&
      (currentId === undefined || before > currentId))
  ) {
    throw new Error(
      "Telegram cached history requires an exclusive native before ID at or before the current message.",
    );
  }
  const limit = Math.min(readPositiveIntegerParam(params, "limit") ?? 50, MAX_MESSAGES);
  const cache = createTelegramMessageCache({
    scope: resolveTelegramMessageCacheScope(
      resolveStorePath(cfg.session?.store, {
        agentId: resolveTelegramAccountOwnerAgentId({ cfg, accountId: scope.accountId }),
      }),
    ),
  });
  const sessionKey = context?.sessionKey?.trim();
  const entry = sessionKey
    ? getSessionEntry({
        sessionKey,
        storePath: resolveStorePath(cfg.session?.store, {
          agentId: resolveAgentIdFromSessionKey(sessionKey),
        }),
      })
    : undefined;
  if (context?.conversationReadOrigin === "delegated" && !entry) {
    throw new Error("Telegram cached history requires the current host session.");
  }
  const minTimestamp =
    entry?.sessionStartedAt === undefined
      ? undefined
      : Math.floor(entry.sessionStartedAt / 1000) * 1000;
  // Scan relative to the trusted current message, not the paging cursor: paging
  // backwards must never cross a reset that occurred after the requested cursor.
  const nodes = await cache.recentBefore({
    ...scope,
    messageId: String(currentId ?? before),
    limit: SCAN_LIMIT,
  });
  const botInfo = await readCachedTelegramBotInfo({
    accountId: scope.accountId,
    botToken: resolveTelegramToken(cfg, { accountId: scope.accountId }).token,
  });
  const allowed: TelegramCachedMessageNode[] = [];
  for (const node of nodes) {
    if (
      node.historyEligible !== true ||
      (minTimestamp !== undefined &&
        (node.timestamp === undefined || node.timestamp < minTimestamp))
    ) {
      continue;
    }
    if (
      await isSourceAllowed({
        ...scope,
        cfg,
        node,
        botId: botInfo?.botInfo.id,
        botUsername: botInfo?.botInfo.username,
      })
    ) {
      allowed.push(node);
    }
  }
  const boundary = allowed.findLast(isTelegramSessionBoundaryCommandNode);
  const eligible = allowed.filter(
    (node) =>
      Number(node.messageId) < before &&
      (!boundary || Number(node.messageId) > Number(boundary.messageId)),
  );
  const messages: SafeMessage[] = [];
  const result: {
    ok: true;
    source: string;
    messages: SafeMessage[];
    nextBefore?: string;
    hasMore: boolean;
  } = {
    ok: true,
    source: "telegram-cache",
    messages,
    nextBefore: undefined,
    hasMore: false,
  };
  for (const node of eligible.toReversed()) {
    if (messages.length >= limit) {
      break;
    }
    const projected = projectMessage(node);
    messages.unshift(projected);
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_RESULT_BYTES - 128) {
      messages.shift();
      if (messages.length === 0) {
        projected.truncated = true;
        let body = projected.body ?? "";
        do {
          body = body.slice(0, Math.floor(body.length / 2));
          projected.body = body;
        } while (
          body &&
          Buffer.byteLength(JSON.stringify(projected), "utf8") > MAX_RESULT_BYTES - 512
        );
        if (Buffer.byteLength(JSON.stringify(projected), "utf8") <= MAX_RESULT_BYTES - 512) {
          messages.push(projected);
        }
      }
      break;
    }
  }
  result.nextBefore = messages[0]?.messageId;
  result.hasMore = eligible.length > messages.length;
  return result;
}
