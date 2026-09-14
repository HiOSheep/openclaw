import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { strictlyValidateConfigSnapshotForCli } from "../cli/config-cli-validation.js";
import { recordDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveDeferredPluginMigrationConfigPaths } from "./deferred-plugin-migration-config.js";
import { createConfigIO } from "./io.factory.js";
import { resolveSessionStoreCompatibilityAgentId } from "./legacy.default-agent-owner.js";
import { migratePersistedImplicitMainRoster } from "./legacy.roster.js";
import {
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "./validation.js";

describe("config IO with deferred plugin migrations", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      cleanup();
    });
  });

  it("serves valid config while preserving pending inputs through repair writes and restart", async () => {
    const root = tempDirs.make("openclaw-deferred-plugin-config-");
    const stateDir = path.join(root, "state");
    const configPath = path.join(root, "openclaw.json");
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      SESSION_ROOT: "/srv/synthetic-session-state",
    };
    const source = {
      gateway: { mode: "local", port: 18789 },
      session: { store: "${SESSION_ROOT}/sessions.json" },
      plugins: {
        entries: { sample: { config: { legacyRoot: "${SESSION_ROOT}/plugin" } } },
      },
      legacySample: { root: "${SESSION_ROOT}/legacy" },
    };
    fs.writeFileSync(configPath, JSON.stringify(source));
    const pending = {
      pluginId: "sample",
      reason: "The configured plugin is not installed.",
      command: "openclaw plugins install @example/sample",
      ...resolveDeferredPluginMigrationConfigPaths({
        config: source,
        pluginId: "sample",
        compatibilityMigrationPaths: ["legacySample"],
      }),
    };
    const admitted = await createConfigIO({
      env,
      configPath,
      observe: false,
      pluginValidation: "core-only",
      deferredPluginMigrations: [pending],
    }).readConfigFileSnapshot();
    expect(admitted.valid).toBe(true);
    expect(admitted.raw).toBe(JSON.stringify(source));
    expect(fs.existsSync(stateDir)).toBe(false);
    recordDeferredPluginMigrations({ env, pending: [pending] });
    closeOpenClawStateDatabaseForTest();
    const io = createConfigIO({
      env,
      configPath,
      observe: false,
      pluginValidation: "core-only",
      shellEnvFallback: "defer",
    });
    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.valid).toBe(true);
    expect((await strictlyValidateConfigSnapshotForCli(snapshot)).valid).toBe(true);
    expect(snapshot.config.gateway?.port).toBe(18789);
    expect(snapshot.config).not.toHaveProperty("legacySample");
    expect(snapshot.sourceConfig).toHaveProperty("legacySample.root", `${env.SESSION_ROOT}/legacy`);
    expect(io.loadConfig().gateway?.port).toBe(18789);

    await io.writeConfigFile(
      { gateway: { mode: "local", port: 18790 } },
      { auditOrigin: "doctor", skipPluginValidation: true, skipRuntimeSnapshotRefresh: true },
    );
    const retained: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(retained).toMatchObject({
      ...source,
      gateway: { mode: "local", port: 18790 },
    });

    recordDeferredPluginMigrations({ env, pending: [], resolvedPluginIds: ["sample"] });
    closeOpenClawStateDatabaseForTest();
    expect((await io.readConfigFileSnapshot()).valid).toBe(false);
    await io.writeConfigFile(
      {
        gateway: { mode: "local", port: 18791 },
        session: source.session,
        plugins: { entries: { sample: { config: { root: "${SESSION_ROOT}/legacy" } } } },
      },
      { auditOrigin: "doctor", skipPluginValidation: true, skipRuntimeSnapshotRefresh: true },
    );
    const migrated: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(migrated).not.toHaveProperty("legacySample");
    expect(migrated).not.toHaveProperty("plugins.entries.sample.config.legacyRoot");
    expect(migrated).toHaveProperty("plugins.entries.sample.config.root", "${SESSION_ROOT}/legacy");
    expect((await io.readConfigFileSnapshot()).valid).toBe(true);
  });

  it("excludes only the declared pending fields from validation", () => {
    const result = validateConfigObjectWithPlugins(
      { gateway: { port: "invalid" }, legacySample: { root: "/srv/sample" } },
      {
        pluginValidation: "core-only",
        deferredPluginMigrations: [
          {
            pluginId: "sample",
            reason: "The configured plugin is not installed.",
            command: "openclaw plugins install @example/sample",
            configPaths: [["legacySample"]],
            validationExcludedPaths: [["legacySample"]],
          },
        ],
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path)).toEqual(["gateway.port"]);
    }
  });

  it("keeps the legacy session owner while excluding a pending plugin field", () => {
    const source = migratePersistedImplicitMainRoster({
      agents: { list: [{ id: "operator", default: true }, { id: "worker" }] },
      legacySample: { root: "/srv/sample" },
    }).config;
    const result = validateConfigObjectWithPlugins(source, {
      pluginValidation: "core-only",
      deferredPluginMigrations: [
        {
          pluginId: "sample",
          reason: "The configured plugin is not installed.",
          command: "openclaw plugins install @example/sample",
          configPaths: [["legacySample"]],
          validationExcludedPaths: [["legacySample"]],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(resolveSessionStoreCompatibilityAgentId(result.config)).toBe("operator");
    }
  });

  it.each(["missing", "stale"])(
    "defers only the unavailable plugin's %s schema and still validates healthy plugins",
    (schemaState) => {
      const schema = {
        type: "object",
        properties: { root: { type: "string" } },
        required: ["root"],
        additionalProperties: false,
      };
      const manifestRegistry = {
        diagnostics: [
          {
            level: "error" as const,
            pluginId: "sample",
            message: "Selected payload is unavailable.",
          },
        ],
        plugins: [
          createPluginManifestRecordFixture({
            id: "sample",
            ...(schemaState === "stale" ? { configSchema: schema } : {}),
            channels: ["sample-channel"],
            channelConfigs: { "sample-channel": { schema } },
          }),
          createPluginManifestRecordFixture({ id: "healthy", configSchema: schema }),
        ],
      };
      const config = {
        plugins: {
          entries: {
            sample: { config: { legacyRoot: "/srv/sample" } },
            healthy: { config: { root: "/srv/healthy" } },
          },
        },
        channels: { "sample-channel": { legacyRoot: "/srv/sample-channel" } },
      };
      const pending = {
        pluginId: "sample",
        reason: "The selected plugin payload has not converged.",
        command: "openclaw doctor --fix",
      };
      const options = {
        pluginMetadataSnapshot: { manifestRegistry },
        deferredPluginMigrations: [pending],
      };
      const result = validateConfigObjectRawWithPlugins(config, options);
      expect(result.ok).toBe(true);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining('Plugin "sample"') }),
      );
      const unrelatedInvalid = validateConfigObjectRawWithPlugins(
        {
          ...config,
          plugins: {
            entries: { ...config.plugins.entries, healthy: { config: { root: 123 } } },
          },
        },
        options,
      );
      expect(unrelatedInvalid.ok).toBe(false);
      if (!unrelatedInvalid.ok) {
        expect(unrelatedInvalid.issues).toContainEqual(
          expect.objectContaining({ path: "plugins.entries.healthy.config.root" }),
        );
        expect(unrelatedInvalid.issues.every((issue) => !issue.path.includes("sample"))).toBe(true);
      }
      expect(
        validateConfigObjectRawWithPlugins(config, { pluginMetadataSnapshot: { manifestRegistry } })
          .ok,
      ).toBe(false);
    },
  );
});
