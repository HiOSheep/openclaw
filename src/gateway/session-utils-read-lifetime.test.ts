import fs from "node:fs";
import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { hasOpenClawAgentDatabaseAsyncResources } from "../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { retainGatewaySessionEntryReadOnly } from "./session-utils-read-lifetime.js";

it.each(["alias replacement", "cold-store close", "same-file reopen"] as const)(
  "rejects a retained metadata read after %s",
  async (change) => {
    await withOpenClawTestState({ label: "metadata-read-owner" }, async (state) => {
      const original = state.path("original.sqlite");
      const replacement = state.path("replacement.sqlite");
      const alias = state.path("selected.sqlite");
      const sessionKey = "agent:main:saved";
      for (const storePath of [original, replacement]) {
        await upsertSessionEntryCore(
          { agentId: "main", storePath, sessionKey },
          { sessionId: "identical-session", updatedAt: 1 },
        );
      }
      fs.symlinkSync(original, alias);
      const config = {
        agents: { entries: { main: { workspace: state.workspaceDir } } },
        session: { store: alias },
      };
      await state.writeConfig(config);
      setRuntimeConfigSnapshot(config);
      if (change === "cold-store close") {
        await closeOpenClawAgentDatabaseByPathAsync(original);
      } else if (change === "same-file reopen") {
        openOpenClawAgentDatabase({ agentId: "main", path: alias });
      }
      const read = retainGatewaySessionEntryReadOnly(sessionKey, "main");
      try {
        expect(read.entry?.sessionId).toBe("identical-session");
        expect(read.isCurrentAtResponse()).toBe(true);
        if (change === "alias replacement") {
          fs.unlinkSync(alias);
          fs.symlinkSync(replacement, alias);
        } else {
          await closeOpenClawAgentDatabaseByPathAsync(read.readSource!.path);
          if (change === "same-file reopen") {
            const successor = retainGatewaySessionEntryReadOnly(sessionKey, "main");
            expect(successor.isCurrentAtResponse()).toBe(true);
            successor.release();
          }
        }
        expect(read.isCurrentAtResponse()).toBe(false);
      } finally {
        read.release();
      }
      expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
    });
  },
);
