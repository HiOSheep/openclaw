import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deleteSessionEntryLifecycle } from "../config/sessions/session-accessor.js";
import {
  loadExactSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { assertSessionStoreMigrationComplete } from "../config/sessions/startup-migration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { recordDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";

function seed(
  state: OpenClawTestState,
  layout: "external" | "default" | "legacy-root" = "external",
) {
  const sessionsDir =
    layout === "external"
      ? path.join(state.root, "external-sessions")
      : layout === "default"
        ? state.sessionsDir("main")
        : state.statePath("sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const storePath = path.join(sessionsDir, "sessions.json");
  const records = Object.fromEntries(
    ["kept", "deleted"].map((name) => {
      const sessionId = `legacy-${name}`;
      const transcript = path.join(sessionsDir, `${sessionId}.jsonl`);
      fs.writeFileSync(
        transcript,
        [
          { type: "session", version: 3, id: sessionId },
          {
            type: "message",
            id: `${name}-message`,
            parentId: null,
            message: { role: "user", content: name },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      fs.writeFileSync(`${transcript}.fixture-plugin.json`, JSON.stringify({ threadId: name }));
      return [
        `agent:main:${name}`,
        { sessionId, sessionFile: path.basename(transcript), updatedAt: 20 },
      ];
    }),
  );
  fs.writeFileSync(storePath, JSON.stringify(records));
  const cfg: OpenClawConfig = {
    agents: { entries: { main: { default: true } } },
    ...(layout === "external" ? { session: { store: storePath } } : {}),
  };
  recordDeferredPluginMigrations({
    env: state.env,
    pending: [
      {
        pluginId: "fixture-plugin",
        reason: "The configured plugin is not installed.",
        command: "openclaw plugins install @example/fixture-plugin",
        ...(layout === "external" ? { configPaths: [["session", "store"]] } : {}),
      },
    ],
  });
  const originals = new Map(
    fs.readdirSync(sessionsDir).map((name) => {
      const file = path.join(sessionsDir, name);
      return [file, fs.readFileSync(file)];
    }),
  );
  const scope = {
    agentId: "main",
    env: state.env,
    storePath:
      layout === "legacy-root" ? path.join(state.sessionsDir("main"), "sessions.json") : storePath,
  };
  return { cfg, storePath, originals, scope };
}

describe("session sources needed by deferred plugin migrations", () => {
  it.each(["external", "default", "legacy-root"] as const)(
    "verifies canonical import and retains %s originals until resolution without replay",
    async (layout) => {
      await withOpenClawTestState({ label: "deferred-plugin-session-source" }, async (state) => {
        const { cfg, storePath, originals, scope } = seed(state, layout);
        expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).toThrow(
          "Legacy session store requires migration",
        );
        const run = () =>
          runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
        const imported = await run();
        expect(imported.totals.importedEntries).toBe(2);
        expect(imported.targets.flatMap((target) => target.issues)).toEqual([
          expect.objectContaining({ code: "plugin_migration_source_retained" }),
        ]);
        for (const [file, bytes] of originals) {
          expect(fs.readFileSync(file)).toEqual(bytes);
        }
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
        expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();

        await upsertSessionEntryCore(
          { ...scope, sessionKey: "agent:main:kept" },
          { label: "changed after import" },
        );
        await deleteSessionEntryLifecycle({
          ...scope,
          target: { canonicalKey: "agent:main:deleted", storeKeys: ["agent:main:deleted"] },
          archiveTranscript: false,
          deleteTranscriptWithoutArchive: true,
        });
        expect((await run()).totals.importedEntries).toBe(0);
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.label,
        ).toBe("changed after import");
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:deleted" }),
        ).toBeUndefined();
        for (const [file, bytes] of originals) {
          expect(fs.readFileSync(file)).toEqual(bytes);
        }

        recordDeferredPluginMigrations({
          env: state.env,
          pending: [],
          resolvedPluginIds: ["fixture-plugin"],
        });
        const resumed = await run();
        expect(resumed.totals.importedEntries).toBe(0);
        expect(resumed.targets.flatMap((target) => target.issues)).toEqual([]);
        expect(fs.existsSync(storePath)).toBe(false);
        expect(resumed.totals.archivedTranscriptFiles).toBe(2);
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.label,
        ).toBe("changed after import");
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:deleted" }),
        ).toBeUndefined();
        expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
      });
    },
  );

  it("does not admit or replay a retained source changed after its verified import", async () => {
    await withOpenClawTestState({ label: "deferred-plugin-source-conflict" }, async (state) => {
      const { cfg, storePath, scope } = seed(state);
      await runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
      await upsertSessionEntryCore(
        { ...scope, sessionKey: "agent:main:kept" },
        { label: "current" },
      );
      fs.appendFileSync(storePath, "\n");
      const retry = await runDoctorSessionSqlite({
        cfg,
        env: state.env,
        allAgents: true,
        mode: "import",
      });
      expect(retry.totals.importedEntries).toBe(0);
      expect(retry.targets.flatMap((target) => target.issues)).toEqual([
        expect.objectContaining({ code: "retained_plugin_source_conflict" }),
      ]);
      expect(loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.label).toBe(
        "current",
      );
      expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).toThrow(
        "Retained session migration source changed",
      );
      expect(fs.existsSync(storePath)).toBe(true);
    });
  });
});
