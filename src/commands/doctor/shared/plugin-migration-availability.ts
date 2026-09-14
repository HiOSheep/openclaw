import { resolveDeferredPluginMigrationConfigPaths } from "../../../config/deferred-plugin-migration-config.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import type { DeferredPluginMigration } from "../../../infra/deferred-plugin-migrations.js";
import { loadManifestMetadataSnapshot } from "../../../plugins/manifest-contract-eligibility.js";
import { isPayloadMissing } from "../../../plugins/payload-verification.js";
import { createPluginCache, withPluginCache } from "../../../plugins/plugin-cache.js";
import {
  collectUpdateDeferredPluginIds,
  resolveConfiguredPluginInstallContext,
} from "./missing-configured-plugin-install.candidates.js";
import {
  collectBlockedPluginIds,
  collectConfiguredChannelIds,
  collectConfiguredPluginIds,
} from "./missing-configured-plugin-install.ids.js";

/** Inspect the selected package generation without importing its Doctor contract. */
export async function inspectPluginMigrationAvailability(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  installRecords?: Record<string, PluginInstallRecord>;
  deferInstallation: boolean;
}): Promise<DeferredPluginMigration[]> {
  return withPluginCache(createPluginCache(), async () => {
    const configuredPluginIds = collectConfiguredPluginIds(params.cfg, params.env);
    const configuredChannelIds = collectConfiguredChannelIds(params.cfg, params.env);
    const blockedPluginIds = collectBlockedPluginIds(params.cfg);
    const context = await resolveConfiguredPluginInstallContext({
      cfg: params.cfg,
      env: params.env,
      configuredPluginIds,
      configuredChannelIds,
      blockedPluginIds,
      baselineRecords: params.installRecords,
    });
    const selected = collectUpdateDeferredPluginIds({
      cfg: params.cfg,
      env: params.env,
      configuredPluginIds,
      configuredChannelIds,
      configuredChannelOwnerPluginIds: context.configuredChannelOwnerPluginIds,
      blockedPluginIds,
    });
    const metadata = loadManifestMetadataSnapshot({ config: params.cfg, env: params.env });
    return [...selected].toSorted().flatMap((pluginId) => {
      if (blockedPluginIds.has(pluginId) || context.bundledPluginsById.has(pluginId)) {
        return [];
      }
      const unavailable =
        !context.knownIds.has(pluginId) ||
        (Object.hasOwn(context.records, pluginId) &&
          isPayloadMissing(params.env, context.records[pluginId]?.installPath)) ||
        context.installedPluginIdsWithRepairablePackages.has(pluginId) ||
        context.configuredPluginIdsWithStaleDescriptors.has(pluginId);
      if (!params.deferInstallation && !unavailable) {
        return [];
      }
      return [
        {
          pluginId,
          ...resolveDeferredPluginMigrationConfigPaths({
            config: params.cfg,
            pluginId,
            compatibilityMigrationPaths: metadata.plugins.find((plugin) => plugin.id === pluginId)
              ?.configContracts?.compatibilityMigrationPaths,
          }),
          reason: params.deferInstallation
            ? "Package convergence must wait until the updating parent releases its install records."
            : "The configured plugin package is missing or has not converged.",
          command: "openclaw update repair",
        },
      ];
    });
  });
}
