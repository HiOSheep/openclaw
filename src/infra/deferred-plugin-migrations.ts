import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { invalidateSuccessfulMigrationCheckpointsInTransaction } from "./startup-migration-checkpoint.js";
import { recordLegacyMigrationRun } from "./state-migrations.receipts.js";

const RUN_PREFIX = "deferred-plugin-migration:";
const deferredPluginMigrationSchema = z.object({
  pluginId: z.string().min(1),
  reason: z.string().min(1),
  command: z.string().min(1),
  configPaths: z.array(z.array(z.string().min(1)).min(1)).optional(),
  validationExcludedPaths: z.array(z.array(z.string().min(1)).min(1)).optional(),
});

export type DeferredPluginMigration = z.infer<typeof deferredPluginMigrationSchema>;

/** Missing metadata cannot release inputs already claimed by an unfinished migration. */
export function mergeDeferredPluginMigration(
  previous: DeferredPluginMigration | undefined,
  current: DeferredPluginMigration,
): DeferredPluginMigration {
  const mergePaths = (before: string[][] = [], after: string[][] = []) => [
    ...new Map(
      [...before, ...after].map((segments) => [JSON.stringify(segments), segments]),
    ).values(),
  ];
  const configPaths = mergePaths(previous?.configPaths, current.configPaths);
  const validationExcludedPaths = mergePaths(
    previous?.validationExcludedPaths,
    current.validationExcludedPaths,
  );
  return {
    pluginId: current.pluginId,
    reason: current.reason,
    command: current.command,
    ...(configPaths.length > 0 ? { configPaths } : {}),
    ...(validationExcludedPaths.length > 0 ? { validationExcludedPaths } : {}),
  };
}

function readMigrationRows(database: DatabaseSync) {
  return executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<Pick<DB, "migration_runs">>(database)
      .selectFrom("migration_runs")
      .select(["id", "status", "report_json"])
      .where("id", "like", `${RUN_PREFIX}%`)
      .orderBy("id"),
  ).rows;
}

export function readDeferredPluginMigrations(
  options: { env?: NodeJS.ProcessEnv } = {},
): readonly DeferredPluginMigration[] {
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
      if (!tableExists(db, "migration_runs")) {
        return [];
      }
      return readMigrationRows(db)
        .filter((row) => row.status === "pending")
        .map((row) => deferredPluginMigrationSchema.parse(JSON.parse(row.report_json)));
    }, options) ?? []
  );
}

export function formatDeferredPluginMigration(pending: DeferredPluginMigration): string {
  const retry = pending.command === "openclaw doctor --fix" ? "" : ', then "openclaw doctor --fix"';
  return `Plugin "${pending.pluginId}" state migration is pending: ${pending.reason} State and legacy config inputs are preserved. Run "${pending.command}"${retry}.`;
}

/** Only the migration owner can resolve a pending record after its work completes. */
export function recordDeferredPluginMigrations(params: {
  env?: NodeJS.ProcessEnv;
  pending: readonly DeferredPluginMigration[];
  resolvedPluginIds?: readonly string[];
}): void {
  if (params.pending.length === 0 && !params.resolvedPluginIds?.length) {
    return;
  }
  const pendingById = new Map(
    params.pending.map((pending) => [
      pending.pluginId,
      deferredPluginMigrationSchema.parse(pending),
    ]),
  );
  const transitions = runOpenClawStateWriteTransaction(
    ({ db }) => {
      const rows = new Map(readMigrationRows(db).map((row) => [row.id, row]));
      const deferred: DeferredPluginMigration[] = [];
      const resolved: string[] = [];
      const now = Date.now();
      for (const current of pendingById.values()) {
        const runId = `${RUN_PREFIX}${current.pluginId}`;
        const previous = rows.get(runId);
        const pending = mergeDeferredPluginMigration(
          previous?.status === "pending"
            ? deferredPluginMigrationSchema.parse(JSON.parse(previous.report_json))
            : undefined,
          current,
        );
        const reportJson = JSON.stringify(pending);
        if (previous?.status === "pending" && previous.report_json === reportJson) {
          continue;
        }
        recordLegacyMigrationRun(db, {
          runId,
          startedAt: now,
          finishedAt: null,
          status: "pending",
          reportJson,
          upsert: true,
        });
        deferred.push(pending);
      }
      for (const pluginId of new Set(params.resolvedPluginIds)) {
        const runId = `${RUN_PREFIX}${pluginId}`;
        const previous = rows.get(runId);
        if (pendingById.has(pluginId) || previous?.status !== "pending") {
          continue;
        }
        recordLegacyMigrationRun(db, {
          runId,
          startedAt: now,
          finishedAt: now,
          status: "completed",
          reportJson: previous.report_json,
          upsert: true,
        });
        resolved.push(pluginId);
      }
      if (deferred.length > 0) {
        invalidateSuccessfulMigrationCheckpointsInTransaction(db);
      }
      return { deferred, resolved };
    },
    { env: params.env },
    { operationLabel: "state.plugin-migration-deferral" },
  );
  const log = createSubsystemLogger("state-migrations");
  for (const pending of transitions.deferred) {
    log.warn(formatDeferredPluginMigration(pending), {
      pluginId: pending.pluginId,
      reason: pending.reason,
      action: pending.command,
      status: "pending",
    });
  }
  for (const pluginId of transitions.resolved) {
    log.info(`Deferred state migration completed for plugin "${pluginId}".`, {
      pluginId,
      status: "completed",
    });
  }
}
