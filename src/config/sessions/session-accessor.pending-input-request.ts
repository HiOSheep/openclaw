import { createHash } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import type { SessionPendingInputRow } from "./session-accessor.sqlite-pending-inputs.js";

export function resolvePendingInputRequestHash(
  message: Record<string, unknown>,
  requestFingerprint?: string,
): string {
  return requestFingerprint
    ? `request:${requestFingerprint}`
    : createHash("sha256").update(stableStringify(message)).digest("hex");
}

export function matchesSessionPendingInputRequest(
  receipt: Pick<SessionPendingInputRow, "request_hash" | "consumed_event_id">,
  message: Record<string, unknown>,
  requestHash: string,
): boolean {
  if (receipt.request_hash === requestHash) {
    return true;
  }
  // Older collectors retain message-hash receipts. Matching one returns its
  // recorded outcome; it must never reopen pre-upgrade execution custody.
  if (receipt.consumed_event_id == null) {
    return false;
  }
  if (receipt.request_hash === resolvePendingInputRequestHash(message)) {
    return true;
  }
  const metadata = asOptionalRecord(message["__openclaw"]);
  const transport = asOptionalRecord(metadata?.transport);
  if (!metadata || !transport || !Object.hasOwn(transport, "clients")) {
    return false;
  }
  // v2026.9.4 Gateway inputs have no client sources. Preserve every other
  // request field while reconstructing their original serialized shape.
  const legacyTransport = { ...transport };
  delete legacyTransport.clients;
  const legacyMetadata = { ...metadata };
  if (Object.keys(legacyTransport).length) {
    legacyMetadata.transport = legacyTransport;
  } else {
    delete legacyMetadata.transport;
  }
  const legacyMessage = { ...message };
  if (Object.keys(legacyMetadata).length) {
    legacyMessage["__openclaw"] = legacyMetadata;
  } else {
    delete legacyMessage["__openclaw"];
  }
  return receipt.request_hash === resolvePendingInputRequestHash(legacyMessage);
}
