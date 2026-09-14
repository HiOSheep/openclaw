import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
} from "./deferred-plugin-migrations.js";
import {
  readMigrationCheckpointStatus,
  recordSuccessfulStartupMigrations,
} from "./startup-migration-checkpoint.js";

const log = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (...args: Parameters<typeof actual.createSubsystemLogger>) => ({
      ...actual.createSubsystemLogger(...args),
      ...log,
    }),
  };
});

describe("deferred configured-plugin migrations", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      cleanup();
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function fixture() {
    const root = tempDirs.make("openclaw-deferred-plugin-migrations-");
    const stateDir = path.join(root, "state");
    return { stateDir, env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
  }

  it("reads absent migration state without creating a database", () => {
    const { env, stateDir } = fixture();
    expect(readDeferredPluginMigrations({ env })).toEqual([]);
    expect(fs.existsSync(stateDir)).toBe(false);
  });

  it("invalidates successful checkpoints until deferred work completes and is certified again", () => {
    const { env } = fixture();
    const checkpoint = {
      env,
      buildIdentity: "test-build",
      version: "2026.9.3",
      identity: {
        effectiveConfigFingerprint: "config",
        pluginDoctorConfigFingerprint: "doctor-config",
        pluginMigrationFingerprint: "plugins",
      },
    };
    recordSuccessfulStartupMigrations(checkpoint);
    expect(readMigrationCheckpointStatus(checkpoint)).toBe("startup-current");
    recordDeferredPluginMigrations({
      env,
      pending: [
        {
          pluginId: "fixture-plugin",
          reason: "The configured plugin is not installed.",
          command: "openclaw doctor --fix",
        },
      ],
    });
    expect(readMigrationCheckpointStatus(checkpoint)).toBe("stale");
    recordDeferredPluginMigrations({ env, pending: [], resolvedPluginIds: ["fixture-plugin"] });
    expect(readMigrationCheckpointStatus(checkpoint)).toBe("stale");
    recordSuccessfulStartupMigrations(checkpoint);
    expect(readMigrationCheckpointStatus(checkpoint)).toBe("startup-current");
  });

  it("retains pending migrations across restart and resolves only the completed plugin", () => {
    const { env } = fixture();
    const alpha = {
      pluginId: "alpha",
      reason: "The configured plugin is not installed.",
      command: "openclaw plugins install @example/alpha",
      configPaths: [
        ["plugins", "entries", "alpha"],
        ["session", "store"],
      ],
      validationExcludedPaths: [["session", "store"]],
    };
    const beta = {
      pluginId: "beta",
      reason: "Plugin convergence is deferred until the update parent exits.",
      command: "openclaw doctor --fix",
    };

    recordDeferredPluginMigrations({ env, pending: [alpha, beta] });
    closeOpenClawStateDatabaseForTest();
    expect(readDeferredPluginMigrations({ env })).toEqual([alpha, beta]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Plugin "alpha" state migration is pending:'),
      { pluginId: "alpha", reason: alpha.reason, action: alpha.command, status: "pending" },
    );

    log.warn.mockClear();
    recordDeferredPluginMigrations({ env, pending: [alpha] });
    expect(log.warn).not.toHaveBeenCalled();

    recordDeferredPluginMigrations({ env, pending: [], resolvedPluginIds: ["alpha"] });
    closeOpenClawStateDatabaseForTest();
    expect(readDeferredPluginMigrations({ env })).toEqual([beta]);
    expect(log.info).toHaveBeenCalledWith(
      'Deferred state migration completed for plugin "alpha".',
      {
        pluginId: "alpha",
        status: "completed",
      },
    );

    recordDeferredPluginMigrations({ env, pending: [], resolvedPluginIds: ["beta"] });
    closeOpenClawStateDatabaseForTest();
    expect(readDeferredPluginMigrations({ env })).toEqual([]);
  });

  it("preserves declared ownership when plugin metadata disappears until explicit completion", () => {
    const { env } = fixture();
    const declared = {
      pluginId: "fixture-plugin",
      reason: "Package convergence is pending.",
      command: "openclaw update repair",
      configPaths: [["legacyIntegration", "stateDirectory"]],
      validationExcludedPaths: [["legacyIntegration"]],
    };
    recordDeferredPluginMigrations({ env, pending: [declared] });
    const unavailable = {
      pluginId: declared.pluginId,
      reason: "Plugin metadata is no longer available.",
      command: "openclaw plugins install @example/fixture-plugin",
    };
    recordDeferredPluginMigrations({ env, pending: [unavailable] });
    closeOpenClawStateDatabaseForTest();
    expect(readDeferredPluginMigrations({ env })).toEqual([{ ...declared, ...unavailable }]);

    const additionalPath = ["plugins", "entries", "fixture-plugin", "config"];
    recordDeferredPluginMigrations({
      env,
      pending: [
        {
          ...unavailable,
          configPaths: [...declared.configPaths, additionalPath],
          validationExcludedPaths: declared.validationExcludedPaths,
        },
      ],
    });
    expect(readDeferredPluginMigrations({ env })).toEqual([
      {
        ...declared,
        ...unavailable,
        configPaths: [...declared.configPaths, additionalPath],
      },
    ]);

    recordDeferredPluginMigrations({ env, pending: [], resolvedPluginIds: [declared.pluginId] });
    expect(readDeferredPluginMigrations({ env })).toEqual([]);
    recordDeferredPluginMigrations({ env, pending: [unavailable] });
    expect(readDeferredPluginMigrations({ env })).toEqual([unavailable]);
  });
});
