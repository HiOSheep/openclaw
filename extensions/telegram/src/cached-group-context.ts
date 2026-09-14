import { resolveChannelGroupPolicy } from "openclaw/plugin-sdk/channel-policy";
import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { expandTelegramAllowFromWithAccessGroups } from "./access-groups.js";
import { firstDefined, normalizeAllowFrom } from "./bot-access.js";
import { hasLeadingBotCommandAddressedToOtherBot } from "./bot/body-helpers.js";
import {
  evaluateTelegramGroupBaseAccess,
  evaluateTelegramGroupPolicyAccess,
} from "./group-access.js";
import { resolveTelegramScopedGroupConfig } from "./group-config-helpers.js";
import { resolveTelegramCommandIngressAuthorization } from "./ingress.js";
import {
  isTelegramMessageFromCurrentBot,
  type TelegramCachedMessageNode,
} from "./message-cache.js";

/** Cache observations (including embedded replies) are data, not ingress authority. */
export async function selectAllowedTelegramGroupContext(params: {
  cfg: OpenClawConfig;
  telegramCfg: TelegramAccountConfig;
  accountId: string;
  chatId: string | number;
  threadId?: number;
  botId?: number;
  botUsername?: string;
  nodes: readonly TelegramCachedMessageNode[];
  /** Only host-selected current album members may precede history admission. */
  currentBatch?: boolean;
  groupAllowFrom?: Array<string | number>;
}): Promise<Set<string>> {
  const { groupConfig, topicConfig } = resolveTelegramScopedGroupConfig(
    params.telegramCfg,
    params.chatId,
    params.threadId,
  );
  const override = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
  const allowFrom =
    override ??
    params.groupAllowFrom ??
    params.telegramCfg.groupAllowFrom ??
    params.telegramCfg.allowFrom;
  const allowed = new Set<string>();
  const senderAccess = new Map<string, ReturnType<typeof normalizeAllowFrom>>();
  for (const node of params.nodes) {
    if (!params.currentBatch && node.historyEligible !== true) {
      continue;
    }
    if (node.threadId !== (params.threadId === undefined ? undefined : String(params.threadId))) {
      continue;
    }
    const isSelf =
      Boolean(params.botId && isTelegramMessageFromCurrentBot(node.sourceMessage, params.botId)) ||
      (node.sourceMessage.from?.id === 0 && node.sourceMessage.from.is_bot);
    // Without authenticated bot identity, addressed commands cannot establish a reset boundary.
    if (!isSelf && !params.botUsername && /^\/[^\s@]+@/u.test(node.body ?? "")) {
      continue;
    }
    if (
      !isSelf &&
      params.botUsername &&
      hasLeadingBotCommandAddressedToOtherBot(node.sourceMessage, params.botUsername)
    ) {
      continue;
    }
    const senderId = node.senderId ?? "";
    let effectiveGroupAllow = senderAccess.get(senderId);
    if (!effectiveGroupAllow) {
      effectiveGroupAllow = normalizeAllowFrom(
        await expandTelegramAllowFromWithAccessGroups({
          cfg: params.cfg,
          accountId: params.accountId,
          senderId,
          allowFrom,
        }),
      );
      senderAccess.set(senderId, effectiveGroupAllow);
    }
    if (
      !evaluateTelegramGroupBaseAccess({
        isGroup: true,
        groupConfig,
        topicConfig,
        effectiveGroupAllow,
        hasGroupAllowOverride: override !== undefined,
        senderId,
        enforceAllowOverride: !isSelf,
        requireSenderForAllowOverride: true,
      }).allowed ||
      !evaluateTelegramGroupPolicyAccess({
        isGroup: true,
        chatId: params.chatId,
        cfg: params.cfg,
        telegramCfg: params.telegramCfg,
        groupConfig,
        topicConfig,
        effectiveGroupAllow,
        senderId,
        enforcePolicy: true,
        enforceAllowlistAuthorization: !isSelf,
        allowEmptyAllowlistEntries: false,
        requireSenderForAllowlistAuthorization: true,
        checkChatAllowlist: true,
        resolveGroupPolicy: (chatId, cfg) =>
          resolveChannelGroupPolicy({
            cfg,
            channel: "telegram",
            accountId: params.accountId,
            groupId: String(chatId),
          }),
      }).allowed
    ) {
      continue;
    }
    // Self replies still obey room availability, but are not inbound user commands.
    if (isSelf) {
      allowed.add(node.messageId);
      continue;
    }
    if (hasControlCommand(node.body ?? "", params.cfg, { botUsername: params.botUsername })) {
      const gate = await resolveTelegramCommandIngressAuthorization({
        cfg: params.cfg,
        accountId: params.accountId,
        chatId: params.chatId,
        resolvedThreadId: params.threadId,
        senderId,
        isGroup: true,
        dmPolicy: "pairing",
        effectiveGroupAllow,
        effectiveDmAllow: normalizeAllowFrom([]),
        ownerAccess: { ownerList: [], senderIsOwner: false },
        eventKind: "message",
        allowTextCommands: true,
        hasControlCommand: true,
        modeWhenAccessGroupsOff: "allow",
        includeDmAllowForGroupCommands: false,
      });
      if (gate.shouldBlockControlCommand) {
        continue;
      }
    }
    allowed.add(node.messageId);
  }
  return allowed;
}
