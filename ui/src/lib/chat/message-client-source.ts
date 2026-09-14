import type { MessageClientSource } from "../../../../src/chat/message-client-source.js";
import { t } from "../../i18n/index.ts";
import { gatewayClientKind } from "../gateway-client-kind.ts";

export function messageClientSourcesLabel(sources: readonly MessageClientSource[]): string {
  const labels = sources.map((source) => {
    const kind = gatewayClientKind(source) ?? "rpc";
    const label = t(`chat.messages.sourceKinds.${kind}`);
    return source.displayName && source.displayName !== label
      ? `${label} (${source.displayName})`
      : label;
  });
  return t("chat.messages.viaSource", { source: [...new Set(labels)].join(", ") });
}
