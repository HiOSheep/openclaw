import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { resolveBunGlobalInstallOwner } from "./detect-package-manager.js";
import { formatDiskSpaceBytes, tryReadDiskSpace } from "./disk-space.js";
import { hasNodeErrorCode } from "./path-guards.js";
import { measureInitialUpdateSnapshotCapacity } from "./update-candidate-snapshot.js";
import {
  resolveNpmGlobalPrefixLayoutFromGlobalRoot,
  resolvePnpmGlobalDirFromGlobalRoot,
  type ResolvedGlobalInstallTarget,
} from "./update-global.js";
import { resolveGitPreflightBaseDir } from "./update-runner-git-preflight.js";
import type { UpdateStepResult } from "./update-runner-types.js";

export const UPDATE_DISK_SPACE_FAILURE_REASON = "insufficient-disk-space";

// Preserve Doctor's critical headroom for config, session, and log writes during the update.
const VOLUME_RESERVE_BYTES = 100 * 1024 * 1024;
const INCOMPLETE_ESTIMATE_WARNING =
  "capacity estimate incomplete: plugin copies and registered external databases are measured after staging";

type Volume = {
  paths: Set<string>;
  availableBytes: number;
  requiredBytes: number;
};

async function measureInstallBytes(
  root: string,
  git: boolean,
): Promise<{ bytes: number; incomplete: boolean }> {
  const directories = new Set<string>();
  let incomplete = false;
  async function visit(file: string, top = false): Promise<number> {
    try {
      const actual = await fs.realpath(file);
      const stat = await fs.stat(actual);
      if (!stat.isDirectory()) {
        return Math.max(4096, Math.ceil(stat.size / 4096) * 4096);
      }
      if (directories.has(actual)) {
        return 0;
      }
      directories.add(actual);
      let bytes = 4096;
      for (const entry of await fs.readdir(actual, { withFileTypes: true })) {
        if (git && top && (entry.name === ".git" || entry.name === ".artifacts")) {
          continue;
        }
        bytes += await visit(path.join(actual, entry.name));
      }
      return bytes;
    } catch {
      incomplete = true;
      return 0;
    }
  }
  return { bytes: await visit(root, true), incomplete };
}

function formatCapacityBytes(bytes: number): string {
  return `${formatDiskSpaceBytes(bytes)} (${bytes} bytes)`;
}

function describeVolume(volume: Volume, additionalBytes = 0): string {
  const required = volume.requiredBytes + additionalBytes;
  const shortfall = Math.max(0, required - volume.availableBytes);
  return `${[...volume.paths].join(", ")}: ${formatCapacityBytes(required)} required, ${formatCapacityBytes(volume.availableBytes)} free, ${formatCapacityBytes(shortfall)} shortfall`;
}

/** Estimate peak writes before staging; unavailable measurements remain visible warnings. */
export async function assessUpdateDiskSpace(params: {
  root: string;
  installTarget?: ResolvedGlobalInstallTarget;
  gitRoot?: string;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<UpdateStepResult> {
  const started = Date.now();
  const warnings = [INCOMPLETE_ESTIMATE_WARNING];
  const volumes = new Map<number, Volume>();
  const probes = new Map<string, ReturnType<typeof tryReadDiskSpace>>();
  const unmeasured = new Set<string>();
  const probe = (target: string) => {
    if (!probes.has(target)) {
      probes.set(target, tryReadDiskSpace(target));
    }
    return probes.get(target) ?? null;
  };
  const volumeFor = (target: string): Volume | undefined => {
    const snapshot = probe(target);
    if (!snapshot) {
      if (!unmeasured.has(target)) {
        unmeasured.add(target);
        warnings.push(
          `Free disk space could not be measured at ${target}; continuing with an incomplete estimate.`,
        );
      }
      return undefined;
    }
    let volume = volumes.get(snapshot.deviceId);
    if (!volume) {
      volume = {
        paths: new Set(),
        availableBytes: snapshot.availableBytes,
        requiredBytes: VOLUME_RESERVE_BYTES,
      };
      volumes.set(snapshot.deviceId, volume);
    }
    volume.paths.add(target);
    volume.availableBytes = Math.min(volume.availableBytes, snapshot.availableBytes);
    return volume;
  };
  const charge = (target: string, bytes: number) => {
    const volume = volumeFor(target);
    if (volume) {
      volume.requiredBytes += bytes;
    }
  };
  const measure = async (root: string, git = false) => {
    const measured = await measureInstallBytes(root, git);
    if (measured.incomplete) {
      warnings.push(
        `The installation size at ${root} could not be fully measured; continuing with the measured files as an incomplete estimate.`,
      );
    }
    return measured.bytes;
  };

  const stateDir = resolveStateDir(params.env);
  charge(stateDir, 0);
  const configPath = resolveConfigPath(params.env);
  let configBytes = 0;
  try {
    configBytes = (await fs.stat(configPath)).size;
  } catch (error) {
    if (!hasNodeErrorCode(error, "ENOENT")) {
      warnings.push(
        `The config backup size at ${configPath} could not be measured; continuing with an incomplete estimate.`,
      );
    }
  }
  charge(`${configPath}.pre-update`, configBytes);

  const installRoot = params.installTarget?.packageRoot ?? params.gitRoot ?? params.root;
  const packageBytes = await measure(installRoot, Boolean(params.gitRoot));
  const target = params.installTarget;
  if (target?.manager === "npm") {
    const layout = resolveNpmGlobalPrefixLayoutFromGlobalRoot(target.globalRoot, {
      allowDirectNodeModulesRoot: target.directNodeModulesRoot === true,
    });
    charge(layout?.globalRoot ?? target.globalRoot ?? params.root, packageBytes);
    if (layout) {
      charge(layout.binDir, 0);
    }
  } else if (target) {
    const owner =
      target.manager === "pnpm"
        ? resolvePnpmGlobalDirFromGlobalRoot(target.globalRoot)
        : resolveBunGlobalInstallOwner(target.packageRoot, params.env)?.globalProjectRoot;
    if (owner) {
      try {
        const project = await fs.realpath(owner);
        const projectBytes = await measure(project);
        charge(path.dirname(project), projectBytes + packageBytes);
        charge(project, 0);
      } catch {
        warnings.push(
          `The ${target.manager} global project at ${owner} could not be located; continuing with an incomplete estimate.`,
        );
      }
    } else {
      warnings.push(
        `The ${target.manager} global project could not be located; continuing with an incomplete estimate.`,
      );
      charge(target.globalRoot ?? params.root, packageBytes);
    }
  }
  if (params.gitRoot || !target) {
    const gitRoot = params.gitRoot ?? params.root;
    const gitBytes = gitRoot === installRoot ? packageBytes : await measure(gitRoot, true);
    charge(gitRoot, gitBytes);
    const stageRoot = resolveGitPreflightBaseDir(resolvePathViaExistingAncestorSync(gitRoot));
    charge(stageRoot, gitBytes);
  }
  charge(
    params.env.TMPDIR?.trim() || params.env.TMP?.trim() || params.env.TEMP?.trim() || os.tmpdir(),
    0,
  );
  warnings.push(
    "Package-manager temporary scratch growth is unknown; its volume retains the disk-space reserve.",
  );

  const snapshotAlternatives: string[] = [];
  let snapshotRefused = false;
  try {
    const snapshot = await measureInitialUpdateSnapshotCapacity({
      config: params.config,
      stateDir,
      env: params.env,
    });
    let selected = false;
    let unknown = false;
    for (const candidate of snapshot.candidates) {
      const observed = probe(candidate.directory);
      if (!observed) {
        unknown = true;
        snapshotAlternatives.push(
          `${candidate.directory}: ${formatCapacityBytes(snapshot.requiredBytes + VOLUME_RESERVE_BYTES)} required, free space unavailable`,
        );
        continue;
      }
      const existing = volumes.get(observed.deviceId);
      const volume: Volume = existing ?? {
        paths: new Set([candidate.directory]),
        availableBytes: observed.availableBytes,
        requiredBytes: VOLUME_RESERVE_BYTES,
      };
      const available = Math.min(volume.availableBytes, observed.availableBytes);
      snapshotAlternatives.push(
        `${candidate.directory}: ${describeVolume({ ...volume, availableBytes: available }, snapshot.requiredBytes)}`,
      );
      if (available >= volume.requiredBytes + snapshot.requiredBytes) {
        charge(candidate.directory, snapshot.requiredBytes);
        selected = true;
        break;
      }
    }
    snapshotRefused = !selected && !unknown;
    if (!selected && unknown) {
      warnings.push(
        "Snapshot capacity could not be fully measured; the candidate snapshot check will verify its location after staging.",
      );
    }
  } catch {
    warnings.push(
      "The initial state snapshot size could not be measured; the candidate snapshot check will verify capacity after staging.",
    );
  }

  const refused =
    snapshotRefused ||
    [...volumes.values()].some((volume) => volume.availableBytes < volume.requiredBytes);
  for (const volume of volumes.values()) {
    if (
      volume.availableBytes >= volume.requiredBytes &&
      volume.availableBytes < volume.requiredBytes + VOLUME_RESERVE_BYTES
    ) {
      warnings.push(
        `Marginal disk space after the update estimate: ${describeVolume(volume)}. Free additional space if possible.`,
      );
    }
  }
  const details = [...volumes.values()].map((volume) => describeVolume(volume));
  if (snapshotRefused) {
    details.push(
      "No snapshot location fits after the other update allocations:",
      ...snapshotAlternatives,
    );
  }
  const message = [
    refused
      ? `${UPDATE_DISK_SPACE_FAILURE_REASON}: update refused before staging.`
      : "Disk space preflight passed using the current installation size estimate.",
    ...details,
    ...(refused
      ? [
          "Free space on the reported volumes before retrying; move unneeded files or old downloads off those volumes. Config writes, session transcripts, and log rotation may fail silently when disk space is critically low. Run openclaw doctor to check disk health. Set TMPDIR to a writable volume with enough space for temporary snapshots.",
        ]
      : []),
  ].join("\n");
  return {
    name: "disk space preflight",
    command: "disk space preflight",
    cwd: params.root,
    durationMs: Date.now() - started,
    exitCode: refused ? 1 : 0,
    ...(refused
      ? { stderrTail: message }
      : {
          stdoutTail: message,
          advisory: { kind: "recoverable-maintenance", message: warnings.join("\n") },
        }),
    warnings,
  };
}
