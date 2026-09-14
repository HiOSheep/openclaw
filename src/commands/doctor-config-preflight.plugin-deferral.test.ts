import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readConfigFileSnapshot } from "../config/io.js";
import { readDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";

async function installMigrationFixture(params: {
  root: string;
  pluginId: string;
  source: string;
  migrated: string;
  stale?: boolean;
}) {
  await fs.mkdir(params.root, { recursive: true });
  await fs.writeFile(
    path.join(params.root, "package.json"),
    JSON.stringify({
      name: "@example/deferred-fixture",
      version: "1.0.0",
      openclaw: { extensions: ["./index.cjs"] },
    }),
  );
  await fs.writeFile(path.join(params.root, "index.cjs"), "module.exports = {};\n");
  await fs.writeFile(
    path.join(params.root, "openclaw.plugin.json"),
    JSON.stringify({
      id: params.pluginId,
      configSchema: { type: "object", properties: {}, additionalProperties: false },
      doctorContract: { configRepair: true, stateMigrations: [{ id: "legacy-binding" }] },
      configContracts: { compatibilityMigrationPaths: ["legacyFixture"] },
    }),
  );
  await fs.writeFile(
    path.join(params.root, "doctor-contract-api.cjs"),
    `
    const fs = require("node:fs");
    const staleCall = () => fs.writeFileSync(${JSON.stringify(path.join(params.root, "stale-called"))}, "called");
    module.exports = {
      legacyConfigRules: [{ path: ["legacyFixture"], message: "Fixture legacy locator must migrate.",
        match: () => { ${params.stale ? 'staleCall(); throw new Error("Stale config detector executed before convergence");' : "return true;"} },
      }, {
        path: ["plugins", "entries", ${JSON.stringify(params.pluginId)}, "config", "legacyBinding"],
        message: "Fixture legacy binding must migrate.",
      }],
      normalizeCompatibilityConfig: ({ cfg }) => {
        ${
          params.stale
            ? 'throw new Error("Stale normalizer executed before convergence");'
            : `const next = structuredClone(cfg); delete next.legacyFixture;
        const pluginConfig = next.plugins?.entries?.[${JSON.stringify(params.pluginId)}]?.config;
        const legacyBinding = pluginConfig?.legacyBinding;
        if (pluginConfig) delete pluginConfig.legacyBinding;
        return { config: next, changes: cfg.legacyFixture || legacyBinding ? ["Retired fixture locator"] : [] };`
        }
      },
      stateMigrations: [{
      id: "legacy-binding", label: "Fixture legacy binding",
      detectLegacyState: () => {
        ${params.stale ? 'throw new Error("Stale detector executed before convergence");' : `return fs.existsSync(${JSON.stringify(params.source)}) ? { preview: ["Import binding"] } : null;`}
      },
      migrateLegacyState: () => {
        fs.renameSync(${JSON.stringify(params.source)}, ${JSON.stringify(params.migrated)});
        return { changes: ["Imported fixture binding"], warnings: [] };
      },
    }] };
  `,
  );
}

describe("configured plugin migration deferral", () => {
  it.each([true, false])(
    "retires same-Doctor deferral inputs with prepared metadata: %s",
    async (preparePluginMetadataSnapshot) => {
      await withDoctorConfigPreflightHome(async (home) => {
        const configPath = path.join(home, ".openclaw", "openclaw.json");
        const pluginRoot = path.join(home, "fixture-plugin");
        const source = path.join(home, "legacy-binding.json");
        const migrated = path.join(home, "migrated-binding.json");
        const pluginId = "deferred-fixture";
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(source, '{"binding":"retained"}\n');
        await fs.writeFile(
          configPath,
          JSON.stringify({
            gateway: { mode: "local" },
            plugins: {
              allow: [pluginId],
              entries: { [pluginId]: { enabled: true, config: { legacyBinding: source } } },
              load: { paths: [pluginRoot] },
            },
          }),
        );
        let installed = false;
        await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
          const completed = await runDoctorConfigPreflight({
            migrateLegacyConfig: false,
            invalidConfigNote: false,
            doctorOnlyStateMigrations: true,
            repairPrefixedConfig: true,
            preparePluginMetadataSnapshot,
            beforeStateMigrations: async (snapshot) => {
              if (snapshot && !installed) {
                await installMigrationFixture({ root: pluginRoot, pluginId, source, migrated });
                installed = true;
              } else if (snapshot) {
                expect(readDeferredPluginMigrations()).toEqual([
                  expect.objectContaining({ pluginId }),
                ]);
              }
              return true;
            },
          });
          expect(installed).toBe(true);
          expect(completed.snapshot.issues).toEqual([]);
          expect(await fs.readFile(migrated, "utf8")).toBe('{"binding":"retained"}\n');
          expect(completed.snapshot.valid).toBe(true);
          expect(readDeferredPluginMigrations()).toEqual([]);
          expect(JSON.parse(await fs.readFile(configPath, "utf8"))).not.toHaveProperty(
            `plugins.entries.${pluginId}.config.legacyBinding`,
          );
          expect((await readConfigFileSnapshot()).valid).toBe(true);
        });
      });
    },
  );

  it.each(["doctor", "startup", "candidate", "stale-candidate"] as const)(
    "%s preserves pending inputs and retries after the package becomes available",
    async (entry) => {
      await withDoctorConfigPreflightHome(async (home) => {
        const configPath = path.join(home, ".openclaw", "openclaw.json");
        const pluginRoot = path.join(home, "fixture-plugin");
        const currentPluginRoot = path.join(home, "fixture-plugin-current");
        const source = path.join(home, "legacy-binding.json");
        const migrated = path.join(home, "migrated-binding.json");
        const pluginId = "deferred-fixture";
        const config = {
          gateway: { mode: "local" },
          agents: { ownership: "explicit", list: [{ id: "alpha" }, { id: "beta" }] },
          ...(entry === "stale-candidate" ? { legacyFixture: source } : {}),
          plugins: {
            allow: [pluginId],
            entries: { [pluginId]: { enabled: true, config: { legacyBinding: source } } },
            ...(entry === "stale-candidate" ? { load: { paths: [pluginRoot] } } : {}),
          },
        };
        if (entry === "stale-candidate") {
          await installMigrationFixture({
            root: pluginRoot,
            pluginId,
            source,
            migrated,
            stale: true,
          });
        }
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, JSON.stringify(config));
        await fs.writeFile(source, '{"binding":"retained"}\n');
        const original = await fs.readFile(configPath, "utf8");
        const options = {
          migrateLegacyConfig: false,
          invalidConfigNote: false,
          doctorOnlyStateMigrations: entry !== "startup",
          repairPrefixedConfig: true,
          requireStartupMigrationCheckpoint: entry === "startup",
        } as const;
        await withEnvAsync(
          {
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            OPENCLAW_UPDATE_IN_PROGRESS: entry.endsWith("candidate") ? "1" : undefined,
            OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: entry.endsWith("candidate")
              ? "1"
              : undefined,
            OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: undefined,
          },
          async () => {
            const pending = await runDoctorConfigPreflight(options);
            expect(pending.stateMigrationStepReceipts).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  id: `plugin:${pluginId}`,
                  outcome: "deferred",
                  warnings: [expect.stringContaining("openclaw update repair")],
                }),
              ]),
            );
            expect(readDeferredPluginMigrations()).toEqual([
              expect.objectContaining({ pluginId, command: "openclaw update repair" }),
            ]);
            expect(await fs.readFile(configPath, "utf8")).toBe(original);
            expect(await fs.readFile(source, "utf8")).toBe('{"binding":"retained"}\n');
            if (entry === "stale-candidate") {
              await expect(fs.stat(path.join(pluginRoot, "stale-called"))).rejects.toMatchObject({
                code: "ENOENT",
              });
            }
          },
        );

        if (entry === "stale-candidate") {
          await fs.rm(pluginRoot, { recursive: true });
          await fs.writeFile(
            configPath,
            JSON.stringify({
              ...config,
              plugins: { ...config.plugins, load: { paths: [] } },
            }),
          );
          await withEnvAsync(
            {
              OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
              OPENCLAW_UPDATE_IN_PROGRESS: undefined,
              OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: undefined,
            },
            async () => {
              const retry = await runDoctorConfigPreflight({
                ...options,
                requireStartupMigrationCheckpoint: true,
              });
              expect(retry.snapshot.valid).toBe(true);
              expect(readDeferredPluginMigrations()[0]?.validationExcludedPaths).toContainEqual([
                "legacyFixture",
              ]);
              expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toHaveProperty(
                "legacyFixture",
                source,
              );
            },
          );
        }
        await installMigrationFixture({ root: currentPluginRoot, pluginId, source, migrated });
        if (entry === "doctor") {
          await fs.writeFile(
            configPath,
            JSON.stringify({
              ...config,
              plugins: {
                ...config.plugins,
                entries: { [pluginId]: { ...config.plugins.entries[pluginId], enabled: false } },
                load: { paths: [currentPluginRoot] },
              },
            }),
          );
          await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
            await runDoctorConfigPreflight(options);
            expect(readDeferredPluginMigrations()).toEqual([expect.objectContaining({ pluginId })]);
            expect(await fs.readFile(source, "utf8")).toBe('{"binding":"retained"}\n');
          });
        }
        await fs.writeFile(
          configPath,
          JSON.stringify({
            ...config,
            plugins: { ...config.plugins, load: { paths: [currentPluginRoot] } },
          }),
        );
        if (entry === "doctor") {
          const manifestPath = path.join(currentPluginRoot, "openclaw.plugin.json");
          const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
          await fs.rm(path.join(currentPluginRoot, "doctor-contract-api.cjs"));
          for (const contract of ["absent", "declared-empty", "empty-module"]) {
            await fs.writeFile(
              manifestPath,
              JSON.stringify({
                ...manifest,
                doctorContract: contract === "absent" ? undefined : { stateMigrations: [] },
              }),
            );
            if (contract === "empty-module") {
              await fs.writeFile(
                path.join(currentPluginRoot, "doctor-contract-api.cjs"),
                "module.exports = { stateMigrations: [], normalizeCompatibilityConfig: ({cfg}) => ({config: cfg, changes: []}) };\n",
              );
            }
            await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
              const unfinished = await runDoctorConfigPreflight({
                ...options,
                requireStartupMigrationCheckpoint: true,
              });
              expect(readDeferredPluginMigrations()).toEqual([
                expect.objectContaining({ pluginId }),
              ]);
              expect(await fs.readFile(source, "utf8")).toBe('{"binding":"retained"}\n');
              expect(unfinished.stateMigrationStepReceipts).toContainEqual(
                expect.objectContaining({ id: `plugin:${pluginId}`, outcome: "deferred" }),
              );
            });
          }
          const resumedPluginRoot = path.join(home, "fixture-plugin-resumed");
          await installMigrationFixture({ root: resumedPluginRoot, pluginId, source, migrated });
          await fs.writeFile(
            configPath,
            JSON.stringify({
              ...config,
              plugins: { ...config.plugins, load: { paths: [resumedPluginRoot] } },
            }),
          );
        }
        await withEnvAsync(
          {
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            OPENCLAW_UPDATE_IN_PROGRESS: undefined,
            OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: undefined,
            OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: undefined,
          },
          async () => {
            const completed = await runDoctorConfigPreflight({
              ...options,
              doctorOnlyStateMigrations: true,
            });
            expect(await fs.readFile(migrated, "utf8")).toBe('{"binding":"retained"}\n');
            expect(readDeferredPluginMigrations()).toEqual([]);
            expect(
              completed.stateMigrationStepReceipts?.filter(
                (receipt) => receipt.outcome === "deferred",
              ),
            ).toEqual([]);
          },
        );
      });
    },
  );
});
