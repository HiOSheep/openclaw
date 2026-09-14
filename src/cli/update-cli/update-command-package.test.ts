import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../../scripts/lib/package-dist-inventory.ts";
import * as diskSpace from "../../infra/disk-space.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-steps.js";
import {
  createNpmTarget,
  writePackageRoot,
} from "../../infra/package-update-steps.test-support.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import * as processRunner from "../../process/exec.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { runPackageInstallUpdate, stagePackageInstallUpdate } from "./update-command-package.js";
import { completeUpdateCommandRun } from "./update-command-run.js";

afterEach(() => vi.restoreAllMocks());
afterEach(() => closeOpenClawStateDatabaseForTest());

async function createPackageInstallFixture(
  base: string,
  candidateVersion = "1.0.0",
  buildId?: string,
) {
  const globalRoot = path.join(base, "prefix", "lib", "node_modules");
  const target = createNpmTarget(globalRoot);
  const root = path.join(globalRoot, "openclaw");
  await writePackageRoot(root, "1.0.0");
  if (buildId) {
    await fs.writeFile(path.join(root, "dist", "build-info.json"), JSON.stringify({ buildId }));
    await writePackageDistInventory(root);
  }
  const launcher = path.join(base, "prefix", "bin", "openclaw");
  await fs.mkdir(path.dirname(launcher), { recursive: true });
  await fs.writeFile(launcher, "previous launcher\n");
  const installedPrefixes: string[] = [];
  vi.spyOn(processRunner, "runCommandWithTimeout").mockImplementation(async (argv) => {
    let stdout = "";
    if (argv.join(" ") === "npm --version") {
      stdout = "12.0.0\n";
    } else if (argv.join(" ") === "npm root -g") {
      stdout = `${globalRoot}\n`;
    } else if (argv.includes("--prefix") && (argv.includes("install") || argv.includes("i"))) {
      const prefix = argv[argv.indexOf("--prefix") + 1];
      if (!prefix) {
        throw new Error("Missing actual staged prefix");
      }
      installedPrefixes.push(prefix);
      await writePackageRoot(
        path.join(prefix, "lib", "node_modules", "openclaw"),
        candidateVersion,
      );
      if (buildId) {
        const stagedRoot = path.join(prefix, "lib", "node_modules", "openclaw");
        await fs.writeFile(
          path.join(stagedRoot, "dist", "build-info.json"),
          JSON.stringify({ buildId }),
        );
        await writePackageDistInventory(stagedRoot);
      }
      await fs.mkdir(path.join(prefix, "bin"), { recursive: true });
      await fs.writeFile(path.join(prefix, "bin", "openclaw"), "candidate launcher\n");
    } else {
      throw new Error(`Unexpected package command: ${argv.join(" ")}`);
    }
    return { stdout, stderr: "", code: 0, signal: null, killed: false, termination: "exit" };
  });
  const expectOriginalInstallation = async () => {
    expect(await fs.readFile(launcher, "utf8")).toBe("previous launcher\n");
    expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version).toBe(
      "1.0.0",
    );
  };
  return { root, target, launcher, installedPrefixes, expectOriginalInstallation };
}

it.each([
  "npm-prefix",
  "snapshot",
  "shared-volume",
  "snapshot-fallback",
  "unknown",
  "incomplete",
  "plenty",
] as const)(
  "checks %s capacity before package staging and records the outcome",
  async (scenario) => {
    await withTestDir({ prefix: "update-capacity-" }, async (base) => {
      const fixture = await createPackageInstallFixture(base, "2.0.0");
      if (scenario === "shared-volume") {
        const payload = path.join(fixture.root, "payload.bin");
        await fs.writeFile(payload, "");
        await fs.truncate(payload, 80 * 1024 * 1024);
      }
      const prefix = path.join(base, "prefix");
      const stateDir = path.join(base, "state");
      const env = {
        HOME: base,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
        TMPDIR: path.join(base, "snapshot-tmp"),
      };
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}\n");
      const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
      const mib = 1024 * 1024;
      vi.spyOn(diskSpace, "tryReadDiskSpace").mockImplementation((targetPath) => {
        if (scenario === "unknown") {
          return null;
        }
        const packageVolume = targetPath.startsWith(prefix);
        const stateVolume =
          targetPath === stateDir || targetPath.startsWith(`${stateDir}${path.sep}`);
        const availableBytes =
          scenario === "shared-volume"
            ? 240 * mib
            : scenario === "snapshot-fallback" && targetPath === env.TMPDIR
              ? 150 * mib
              : (scenario === "npm-prefix" && packageVolume) ||
                  (scenario === "snapshot" && !packageVolume && !stateVolume)
                ? (scenario === "snapshot" ? 128 : 32) * mib
                : scenario === "incomplete"
                  ? 512 * mib
                  : 8 * 1024 * mib;
        return {
          targetPath,
          checkedPath: targetPath,
          deviceId:
            scenario === "shared-volume"
              ? 1
              : packageVolume
                ? 1
                : stateVolume
                  ? 2
                  : targetPath === env.TMPDIR
                    ? 3
                    : 4,
          availableBytes,
          totalBytes: 16 * 1024 * mib,
        };
      });
      const allocate = vi.spyOn(fs, "mkdtemp");
      const validateCandidate = vi.fn(async () => [
        { name: "synthetic canary stop", command: "canary", cwd: base, durationMs: 0, exitCode: 1 },
      ]);
      const result = await runPackageInstallUpdate({
        root: fixture.root,
        installKind: "package",
        tag: "2.0.0",
        installTarget: fixture.target,
        installEnv: env,
        managedServiceEnv: env,
        timeoutMs: 1000,
        startedAt: Date.now(),
        progress: {},
        jsonMode: true,
        validateCandidate,
        beforeActivate: vi.fn(),
        onTransaction: vi.fn(),
      });
      completeUpdateCommandRun(result, run);
      const recorded = getUpdateRun(run.runId, { env });
      if (scenario === "npm-prefix" || scenario === "snapshot" || scenario === "shared-volume") {
        expect(result.reason).toBe("insufficient-disk-space");
        const refusal = result.steps.find((step) => step.name === "disk space preflight");
        expect(refusal).toMatchObject({ exitCode: 1 });
        expect(refusal?.stderrTail).toContain(scenario === "npm-prefix" ? prefix : env.TMPDIR);
        expect(refusal?.stderrTail).toMatch(/required|needed/);
        expect(refusal?.stderrTail).toContain(
          scenario === "shared-volume" ? "240 MiB" : scenario === "snapshot" ? "128 MiB" : "32 MiB",
        );
        expect(refusal?.stderrTail).toContain("Free");
        expect(fixture.installedPrefixes).toEqual([]);
        expect(allocate).not.toHaveBeenCalled();
        expect(validateCandidate).not.toHaveBeenCalled();
        expect(recorded).toMatchObject({ status: "failed", reason: "insufficient-disk-space" });
      } else {
        expect(fixture.installedPrefixes).toHaveLength(1);
        expect(validateCandidate).toHaveBeenCalledOnce();
        expect(result.steps).toContainEqual(
          expect.objectContaining({ name: "synthetic canary stop" }),
        );
        expect(recorded?.steps).toContainEqual(
          expect.objectContaining({
            step: "warning:disk space preflight",
            detail:
              "capacity estimate incomplete: plugin copies and registered external databases are measured after staging",
          }),
        );
      }
      expect(await fs.readFile(env.OPENCLAW_CONFIG_PATH, "utf8")).toBe("{}\n");
      await fixture.expectOriginalInstallation();
    });
  },
);

it.each([
  "1.0.0",
  "file:/owned/candidate.tgz",
  "https://example.invalid/candidate.tgz",
  "openclaw@file:/owned/candidate",
  "openclaw@1.0.0",
])(
  "honors the explicit package artifact without changing registry no-op semantics: %s",
  async (tag) => {
    await withTestDir({ prefix: "update-exact-artifact-" }, async (base) => {
      const { root, target, launcher, expectOriginalInstallation } =
        await createPackageInstallFixture(base);
      const stopped = new Error("pause at owned pre-activation boundary");
      const validateCandidate = vi.fn(async (candidate: string) => {
        expect(candidate).not.toBe(root);
        expect(await fs.readFile(launcher, "utf8")).toBe("previous launcher\n");
        return [];
      });
      const beforeActivate = vi.fn(async () => {
        throw stopped;
      });
      const onTransaction = vi.fn();
      const update = runPackageInstallUpdate({
        root,
        installKind: "package",
        tag: tag.startsWith("openclaw@") ? "latest" : tag,
        timeoutMs: 1000,
        startedAt: Date.now(),
        progress: {},
        jsonMode: true,
        installEnv: tag.startsWith("openclaw@") ? { OPENCLAW_UPDATE_PACKAGE_SPEC: tag } : {},
        installTarget: target,
        validateCandidate,
        beforeActivate,
        onTransaction,
      });
      if (tag === "1.0.0" || tag === "openclaw@1.0.0") {
        expect(await update).toMatchObject({ status: "skipped", reason: "already-current" });
        expect(validateCandidate).not.toHaveBeenCalled();
        expect(beforeActivate).not.toHaveBeenCalled();
      } else {
        await expect(update).rejects.toBe(stopped);
        expect(validateCandidate).toHaveBeenCalledOnce();
        expect(beforeActivate).toHaveBeenCalledOnce();
      }
      expect(onTransaction).not.toHaveBeenCalled();
      await expectOriginalInstallation();
    });
  },
);

it.each(["package", "git"] as const)(
  "preserves matching explicit artifact behavior for an existing %s install",
  async (installKind) => {
    await withTestDir({ prefix: "update-matching-artifact-" }, async (base) => {
      const { root, target, expectOriginalInstallation } = await createPackageInstallFixture(
        base,
        "1.0.0",
        "same-build",
      );
      const validateCandidate = vi.fn(async () => [
        { name: "canary", command: "canary", cwd: base, durationMs: 0, exitCode: 1 },
      ]);
      const beforeActivate = vi.fn(async () => {});

      const result = await runPackageInstallUpdate({
        root,
        installKind,
        tag: "https://example.invalid/candidate.tgz",
        timeoutMs: 1000,
        startedAt: Date.now(),
        progress: {},
        jsonMode: true,
        installEnv: {},
        installTarget: target,
        validateCandidate,
        beforeActivate,
        onTransaction: vi.fn(),
      });
      if (installKind === "package") {
        expect(result).toMatchObject({ status: "skipped", reason: "already-current" });
        expect(validateCandidate).not.toHaveBeenCalled();
      } else {
        expect(result).toMatchObject({ status: "error", reason: "unexpected-error" });
        expect(result.steps).toContainEqual(
          expect.objectContaining({ name: "canary", exitCode: 1 }),
        );
        expect(validateCandidate).toHaveBeenCalledOnce();
      }
      expect(beforeActivate).not.toHaveBeenCalled();
      await expectOriginalInstallation();
    });
  },
);

it.each(
  [
    { name: "new version", candidateVersion: "2.0.0", tag: "2.0.0", buildId: undefined },
    {
      name: "matching explicit artifact",
      candidateVersion: "1.0.0",
      tag: "https://example.invalid/candidate.tgz",
      buildId: "same-build",
    },
  ].flatMap(({ name, candidateVersion, tag, buildId }) =>
    (["run", "close"] as const).map((action) => ({ name, candidateVersion, tag, buildId, action })),
  ),
)(
  "retains the exact $name staged runtime without replacing the active installation before $action",
  async ({ action, candidateVersion, tag, buildId }) => {
    await withTestDir({ prefix: "update-retained-stage-" }, async (base) => {
      const { root, target, installedPrefixes, expectOriginalInstallation } =
        await createPackageInstallFixture(base, candidateVersion, buildId);
      const params = {
        root,
        installKind: "package" as const,
        tag,
        timeoutMs: 1000,
        startedAt: Date.now(),
        progress: {},
        jsonMode: true,
        installEnv: {},
        installTarget: target,
      };
      const staged = await stagePackageInstallUpdate(params);
      expect(installedPrefixes).toHaveLength(1);
      expect(staged.root).not.toBe(root);
      expect(
        JSON.parse(await fs.readFile(path.join(staged.root, "package.json"), "utf8")).version,
      ).toBe(candidateVersion);
      await expectOriginalInstallation();
      if (action === "run") {
        const runtimeIdentity = await fs.stat(path.join(staged.root, "dist", "index.js"));
        const stopped = new Error("stop before activating the initialized runtime");
        const validateCandidate = vi.fn(async (candidate: string) => {
          expect(candidate).toBe(staged.root);
          expect(await fs.stat(path.join(candidate, "dist", "index.js"))).toMatchObject({
            ino: runtimeIdentity.ino,
            dev: runtimeIdentity.dev,
          });
          await expectOriginalInstallation();
          return [];
        });
        const beforeActivate = vi.fn(async () => {
          throw stopped;
        });
        const onTransaction = vi.fn();
        await expect(
          staged.run({ ...params, validateCandidate, beforeActivate, onTransaction }),
        ).rejects.toBe(stopped);
        expect(validateCandidate).toHaveBeenCalledOnce();
        expect(beforeActivate).toHaveBeenCalledOnce();
        expect(onTransaction).not.toHaveBeenCalled();
      } else {
        await expect(staged.close()).resolves.toBeUndefined();
      }
      expect(installedPrefixes).toHaveLength(1);
      await expectOriginalInstallation();
      for (const prefix of installedPrefixes) {
        await expect(fs.stat(prefix)).rejects.toMatchObject({ code: "ENOENT" });
      }
    });
  },
);

it("runs package post-update doctor from the verified package root after a staged swap", async () => {
  await withTestDir({ prefix: "update-staged-doctor-" }, async (base) => {
    const globalRoot = path.join(base, "prefix", "lib", "node_modules");
    const root = path.join(globalRoot, "openclaw");
    const entryPath = path.join(root, "dist", "index.js");
    await writePackageRoot(root, "2026.4.21");
    const commands = vi
      .spyOn(processRunner, "runCommandWithTimeout")
      .mockImplementation(async (argv, options) => {
        if (argv[0] === "npm" && argv[1] === "i") {
          const prefix = argv[argv.indexOf("--prefix") + 1];
          if (!argv.includes("--prefix") || !prefix) {
            throw new Error("Missing actual staged prefix");
          }
          await writePackageRoot(path.join(prefix, "lib", "node_modules", "openclaw"), "2026.5.14");
        } else if (argv[2] === "doctor") {
          expect(argv.slice(1)).toEqual([entryPath, "doctor", "--non-interactive", "--fix"]);
          expect(options).toMatchObject({
            cwd: root,
            env: {
              OPENCLAW_SERVICE_REPAIR_POLICY: "external",
              OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.5.14",
            },
          });
          expect(
            JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")),
          ).toMatchObject({ version: "2026.5.14" });
        } else {
          throw new Error(`Unexpected package command: ${argv.join(" ")}`);
        }
        return {
          stdout: "",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        };
      });
    let transaction: PackageUpdateTransaction | undefined;
    try {
      const result = await runPackageInstallUpdate({
        root,
        installKind: "package",
        tag: "2026.5.14",
        installSpec: "openclaw@2026.5.14",
        installTarget: createNpmTarget(globalRoot),
        installEnv: {},
        managedServiceEnv: {
          OPENCLAW_STATE_DIR: path.join(base, "state"),
          OPENCLAW_CONFIG_PATH: path.join(base, "openclaw.json"),
        },
        timeoutMs: 1000,
        startedAt: Date.now(),
        progress: {},
        jsonMode: true,
        validateCandidate: async () => [],
        beforeActivate: async () => {},
        onTransaction: (retained) => {
          transaction = retained;
        },
      });
      expect(result).toMatchObject({ status: "ok", root, after: { version: "2026.5.14" } });
      expect(commands.mock.calls.filter(([argv]) => argv[2] === "doctor")).toHaveLength(1);
    } finally {
      if (transaction) {
        const assertCurrent = () => {};
        // This test never starts a service; restore before retiring the retained package backup.
        const rollback = await transaction.rollback(assertCurrent);
        const retirement = await transaction.complete({ activationVerified: false }, assertCurrent);
        expect(rollback.exitCode).toBe(0);
        expect(retirement).toBeUndefined();
      }
    }
  });
});
