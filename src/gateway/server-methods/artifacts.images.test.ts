import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { ArtifactsListResult } from "../../../packages/gateway-protocol/src/index.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { artifactsHandlers } from "./artifacts.js";
import type { GatewayClient } from "./types.js";

const scope = {
  agentId: "main",
  sessionKey: "agent:main:activity-images",
  sessionId: "activity-images",
};

async function list(params: Record<string, unknown> = {}, client: GatewayClient | null = null) {
  let result: { ok: boolean; payload?: unknown; error?: unknown } | undefined;
  await expectDefined(
    artifactsHandlers["artifacts.list"],
    "artifact list handler",
  )({
    params: { sessionKey: scope.sessionKey, type: "image", limit: 4, ...params },
    context: createDirectChatContext(),
    req: { type: "req", id: "images", method: "artifacts.list" },
    client,
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => {
      result = { ok, payload, error };
    },
  });
  return expectDefined(result, "artifact response");
}

function page(result: Awaited<ReturnType<typeof list>>): ArtifactsListResult {
  expect(result.ok).toBe(true);
  return result.payload as ArtifactsListResult;
}

async function append(content: unknown) {
  await appendTranscriptMessage(scope, { message: { role: "assistant", content } });
}

describe("bounded Activity image discovery", () => {
  it("pages newest images within one message and includes Markdown local images without reading files", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      await append([{ type: "image", data: "aGVsbG8=", mimeType: "image/png", alt: "inline" }]);
      await append(
        Array.from({ length: 5 }, (_, index) => ({
          type: "image",
          url: `https://images.example.test/${index}.png`,
          alt: `image-${index}`,
        })),
      );
      await append(
        "![Screenshot](/synthetic/nonexistent/screenshot.png)\n`![code](/private/code.png)`\n```md\n![fenced](/private/fenced.png)\n```",
      );
      const first = page(await list());
      expect(first.artifacts.map((artifact) => artifact.image?.url)).toEqual([
        "/synthetic/nonexistent/screenshot.png",
        "https://images.example.test/4.png",
        "https://images.example.test/3.png",
        "https://images.example.test/2.png",
      ]);
      expect(first.artifacts[0]?.download.mode).toBe("unsupported");
      await append([{ type: "image", url: "https://images.example.test/new.png" }]);
      const second = page(await list({ cursor: first.nextCursor }));
      expect(second.artifacts.map((artifact) => artifact.image?.url)).toEqual([
        "https://images.example.test/1.png",
        "https://images.example.test/0.png",
        "data:image/png;base64,aGVsbG8=",
      ]);
      expect(second.nextCursor).toBeUndefined();
    });
  });

  it("bounds sparse transcript work and advances past oversized events", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      await append([{ type: "image", url: "https://images.example.test/old.png" }]);
      for (let index = 0; index < 40; index++) await append(`text-${index}`);
      const first = page(await list());
      expect(first.artifacts).toEqual([]);
      expect(first.nextCursor).toEqual(expect.any(String));
      const second = page(await list({ cursor: first.nextCursor }));
      expect(second.artifacts).toHaveLength(1);
      await append([{ type: "image", data: "a".repeat(400_000), mimeType: "image/png" }]);
      const oversized = page(await list());
      expect(oversized.artifacts).toEqual([]);
      expect(oversized.omittedOversized).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(oversized))).toBeLessThan(1024);
      expect(page(await list({ cursor: oversized.nextCursor })).nextCursor).toEqual(
        expect.any(String),
      );
      expect(await list({ limit: 5 })).toMatchObject({ ok: false });
      expect(await list({ type: undefined, limit: 2 })).toMatchObject({ ok: false });
    });
  });

  it("rejects copied, retargeted, and reset cursors while rechecking current session access", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      await append(
        Array.from({ length: 6 }, (_, index) => ({
          type: "image",
          url: `https://images.example.test/${index}.png`,
        })),
      );
      const client = sharingPolicyClient({ user: "image-viewer", scopes: ["operator.read"] });
      const first = page(await list({}, client));
      const cursor = expectDefined(first.nextCursor, "image cursor");
      expect(
        await list(
          { cursor },
          sharingPolicyClient({ user: "image-viewer", scopes: ["operator.read"] }),
        ),
      ).toMatchObject({
        ok: false,
        error: { details: { type: "artifact_cursor_invalid" } },
      });
      const other = { ...scope, sessionKey: "agent:main:other-images", sessionId: "other-images" };
      await upsertSessionEntryCore(other, { sessionId: other.sessionId, updatedAt: 1 });
      expect(await list({ cursor, sessionKey: other.sessionKey }, client)).toMatchObject({
        ok: false,
        error: { details: { type: "artifact_cursor_invalid" } },
      });
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: 2,
        incognito: true,
      });
      expect(await list({ cursor }, client)).toMatchObject({ ok: false });
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: 3,
        incognito: undefined,
      });
      await appendTranscriptEvent(scope, {
        type: "reset",
        id: "reset-image-window",
        timestamp: new Date().toISOString(),
      });
      expect(await list({ cursor }, client)).toMatchObject({
        ok: false,
        error: { details: { type: "artifact_cursor_invalid" } },
      });
    });
  });
});
