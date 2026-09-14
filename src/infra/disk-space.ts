// Reads and formats disk-space snapshots and warnings.
import fs from "node:fs";
import path from "node:path";

type DiskSpaceSnapshot = {
  targetPath: string;
  checkedPath: string;
  deviceId: number;
  availableBytes: number;
  totalBytes: number | null;
};

function finiteNonNegativeNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : null;
}

function findExistingDiskSpacePath(
  targetPath: string,
): { checkedPath: string; deviceId: number } | null {
  let current = path.resolve(targetPath);
  while (true) {
    try {
      const stats = fs.statSync(current);
      if (!stats.isDirectory()) {
        current = path.dirname(current);
        continue;
      }
      return {
        checkedPath: current,
        deviceId: stats.dev,
      };
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  }
}

/** Reads available bytes for the volume containing a target path when statfs is available. */
export function tryReadDiskSpace(targetPath: string): DiskSpaceSnapshot | null {
  if (typeof fs.statfsSync !== "function") {
    return null;
  }
  // Install/update targets may not exist yet; statfs needs the nearest existing
  // ancestor to identify the backing volume.
  const existing = findExistingDiskSpacePath(targetPath);
  if (!existing) {
    return null;
  }
  try {
    const stats = fs.statfsSync(existing.checkedPath);
    const blockSize = finiteNonNegativeNumber(stats.bsize);
    const availableBlocks = finiteNonNegativeNumber(stats.bavail);
    if (blockSize === null || availableBlocks === null) {
      return null;
    }
    const totalBlocks = finiteNonNegativeNumber(stats.blocks);
    return {
      targetPath,
      ...existing,
      availableBytes: blockSize * availableBlocks,
      totalBytes: totalBlocks === null ? null : blockSize * totalBlocks,
    };
  } catch {
    return null;
  }
}

/** Formats byte counts for compact operator-facing disk-space warnings. */
export function formatDiskSpaceBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  // Round before choosing the unit so a value that rounds up to 1024 MiB is
  // promoted to "1.0 GiB" instead of printing the impossible "1024 MiB".
  const roundedMib = Math.max(0, Math.round(mib));
  if (roundedMib < 1024) {
    return `${roundedMib} MiB`;
  }
  const gib = mib / 1024;
  return `${gib.toFixed(gib < 10 ? 1 : 0)} GiB`;
}
