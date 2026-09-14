import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

type Command = { tool: string; args: string[] };

type Step = { name?: string; run?: string; if?: string; env?: Record<string, string> };
const workflow: { jobs: Record<string, { steps: Step[] }> } = parse(
  readFileSync(".github/workflows/ci.yml", "utf8"),
);
const watchStep = workflow.jobs["ios-build"]?.steps.find(
  (step) => step.name === "Run focused Apple Watch operation simulator tests",
);
const iosStep = workflow.jobs["ios-build"]?.steps.find(
  (step) => step.name === "Run focused iOS lifecycle simulator tests",
);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runSimulatorStep(mode = "ready", step = watchStep, phase = "tests") {
  const root = tempDirs.make("openclaw-watch-workflow-");
  const bin = path.join(root, "bin");
  const product = path.join(root, "project derived data", "Watch Product.app");
  mkdirSync(bin, { recursive: true });
  mkdirSync(product, { recursive: true });
  const runner = path.join(root, "tools.mjs");
  writeFileSync(
    runner,
    String.raw`
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
const [tool, ...args] = process.argv.slice(2);
const root = process.env.WATCH_FIXTURE_ROOT;
const mode = process.env.WATCH_FIXTURE_MODE;
appendFileSync(path.join(root, "commands.jsonl"), JSON.stringify({ tool, args }) + "\n");
if (tool === "xcrun") {
  if (args[1] === "list") {
    console.log(JSON.stringify({ devices: { watch: [
      { name: "Apple Watch fixture", isAvailable: true, udid: "watch-fixture" },
      { name: "iPhone fixture", isAvailable: true, udid: "iphone-fixture" }
    ] } }));
  } else if (args[1] === "bootstatus" && mode === "boot-failed") {
    process.exit(23);
  } else if (args[1] === "install" && !existsSync(args[3])) {
    process.exit(24);
  }
} else if (args.includes("-showBuildSettings")) {
  const product = {
    target: "OpenClawWatchApp",
    buildSettings: {
      TARGET_BUILD_DIR: mode === "relative-product" ? "relative" : path.join(root, "project derived data"),
      FULL_PRODUCT_NAME: "Watch Product.app"
    }
  };
  const other = { target: "OtherTarget", buildSettings: { TARGET_BUILD_DIR: "/wrong", FULL_PRODUCT_NAME: "Wrong.app" } };
  console.log(JSON.stringify(mode === "missing-product" ? [other] :
    mode === "ambiguous-product" ? [product, product] : [other, product]));
} else if (args.includes("test") && mode === "tests-failed") {
  process.exit(25);
} else if (args.includes("build-for-testing")) {
  const derivedIndex = args.indexOf("-derivedDataPath");
  if (derivedIndex >= 0) {
    mkdirSync(path.join(args[derivedIndex + 1], "Build/Products/Debug-watchsimulator/OpenClawWatchApp.app"), { recursive: true });
  }
}
`,
  );
  // Exercise the restart helper itself below; this fixture checks workflow ordering.
  for (const tool of ["xcrun", "xcodebuild", "python3"]) {
    const executable = path.join(bin, tool);
    writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath}' '${runner}' '${tool}' "$@"\n`);
    chmodSync(executable, 0o755);
  }
  if (!step?.run) {
    throw new Error("Missing simulator workflow step");
  }
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", step.run], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      RUNNER_TEMP: root,
      WATCH_FIXTURE_ROOT: root,
      WATCH_FIXTURE_MODE: mode,
      IOS_TEST_PHASE: phase,
    },
  });
  const commands: Command[] = readFileSync(path.join(root, "commands.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return { result, commands, product };
}

describe.skipIf(process.platform === "win32")("Watch simulator workflow", () => {
  it("reuses project build products and installs the exact Watch target before running its tests", () => {
    const { result, commands, product } = runSimulatorStep();
    expect(result.status, result.stderr).toBe(0);
    const xcodeCommands = commands.filter((command) => command.tool === "xcodebuild");
    for (const command of xcodeCommands) {
      expect(command.args).not.toContain("-derivedDataPath");
    }
    expect(
      commands.filter((command) => command.tool === "xcrun").map((command) => command.args),
    ).toEqual([
      ["simctl", "list", "devices", "available", "--json"],
      ["simctl", "boot", "watch-fixture"],
      ["simctl", "bootstatus", "watch-fixture", "-b"],
      ["simctl", "install", "watch-fixture", product],
    ]);
    expect(
      xcodeCommands.map((command) =>
        command.args.find((arg) =>
          ["build-for-testing", "-showBuildSettings", "test-without-building"].includes(arg),
        ),
      ),
    ).toEqual(["build-for-testing", "-showBuildSettings", "test-without-building"]);
    for (const command of xcodeCommands.filter(
      (entry) =>
        entry.args.includes("build-for-testing") || entry.args.includes("test-without-building"),
    )) {
      expect(command.args).toEqual(
        expect.arrayContaining([
          "OpenClawWatchApp",
          "Debug",
          "platform=watchOS Simulator,id=watch-fixture",
          "-parallel-testing-enabled",
          "NO",
          "-only-testing:OpenClawWatchTests/WatchInboxStoreOperationTests",
          "-only-testing:OpenClawWatchTests/WatchRealtimeMediaTests",
          "-only-testing:OpenClawWatchTests/WatchGatewayConfigurationTests",
          "CODE_SIGNING_ALLOWED=NO",
        ]),
      );
    }
    expect(
      xcodeCommands.find((command) => command.args.includes("test-without-building"))?.args,
    ).toContain("apps/ios/build/LifecycleTestResults/OpenClawWatchOperationTests.xcresult");
  });

  it.each(["missing-product", "ambiguous-product", "relative-product"])(
    "rejects %s settings before simulator installation or test execution",
    (mode) => {
      const { result, commands } = runSimulatorStep(mode);
      expect(result.status).not.toBe(0);
      expect(commands.some((command) => command.args.includes("install"))).toBe(false);
      expect(commands.some((command) => command.args.includes("test-without-building"))).toBe(
        false,
      );
    },
  );

  it("preserves simulator readiness failure without installing or running tests", () => {
    const { result, commands } = runSimulatorStep("boot-failed");
    expect(result.status).toBe(23);
    expect(commands.some((command) => command.args.includes("install"))).toBe(false);
    expect(commands.some((command) => command.args.includes("test-without-building"))).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("iOS Access simulator workflow", () => {
  const authClasses = [
    "CloudflareAccessClientTests",
    "CloudflareAccessTransferTests",
    "CloudflareAccessSessionStoreTests",
  ];

  it("executes the actual auth test classes during smoke and excludes compatibility targets", () => {
    expect(iosStep?.if).toContain("matrix.phase == 'smoke'");
    expect(iosStep?.if).toContain("needs.preflight.outputs.compatibility_target != 'true'");
    expect(iosStep?.env?.IOS_TEST_PHASE).toBe("${{ matrix.phase }}");
    const { result, commands } = runSimulatorStep("ready", iosStep, "smoke");
    expect(result.status, result.stderr).toBe(0);
    const tests = commands.filter((command) => command.tool === "xcodebuild");
    expect(tests).toHaveLength(1);
    expect(tests[0]?.args).toContain("platform=iOS Simulator,id=iphone-fixture");
    expect(tests[0]?.args.filter((arg) => arg.startsWith("-only-testing:"))).toEqual([
      ...authClasses.map((name) => `-only-testing:OpenClawLogicTests/${name}`),
      "-only-testing:OpenClawTests/GatewayIngressControllerTests",
      "-only-testing:OpenClawTests/GatewayConnectionControllerTests",
      "-only-testing:OpenClawTests/GatewayOperatorFleetTests",
      "-only-testing:OpenClawTests/IOSMediaArtifactLoaderTests",
      "-only-testing:OpenClawTests/OpenClawTypographyTests",
    ]);
    expect(commands.at(-1)).toEqual({
      tool: "python3",
      args: ["scripts/ios-access-restart-proof.py", "iphone-fixture"],
    });
    for (const name of authClasses) {
      expect(readFileSync(`apps/ios/Tests/Logic/${name}.swift`, "utf8")).toContain(
        `struct ${name}`,
      );
    }
  });

  it("keeps full lifecycle and UI tests alongside Access tests in full validation", () => {
    const { result, commands } = runSimulatorStep("ready", iosStep, "tests");
    expect(result.status, result.stderr).toBe(0);
    const tests = commands.filter((command) => command.tool === "xcodebuild");
    expect(tests).toHaveLength(2);
    expect(tests[0]?.args).toEqual(
      expect.arrayContaining([
        ...authClasses.map((name) => `-only-testing:OpenClawLogicTests/${name}`),
        "-only-testing:OpenClawLogicTests/WatchVoiceTurnTrackerTests",
        "-only-testing:OpenClawTests/NodeAppModelInvokeTests",
        "-only-testing:OpenClawTests/OpenClawTypographyTests",
      ]),
    );
    expect(tests[1]?.args).toContain(
      "-only-testing:OpenClawUITests/OpenClawSnapshotUITests/testWatchMessageDeliveryIsReachableFromSettings",
    );
    const restart = commands.findIndex((command) => command.tool === "python3");
    expect(restart).toBeGreaterThan(commands.indexOf(tests[0]!));
    expect(restart).toBeLessThan(commands.indexOf(tests[1]!));
  });

  it("fails on auth test errors before attempting later UI tests", () => {
    const { result, commands } = runSimulatorStep("tests-failed", iosStep, "tests");
    expect(result.status).toBe(25);
    expect(commands.filter((command) => command.tool === "xcodebuild")).toHaveLength(1);
    expect(commands.some((command) => command.tool === "python3")).toBe(false);
  });
});

function runRestartProof(mode = "ready", format = 1) {
  const root = tempDirs.make("openclaw-access-restart-");
  const result = spawnSync(
    "python3",
    [
      "-B",
      "-c",
      String.raw`
import contextlib, hashlib, importlib.util, io, json, os, pathlib, plistlib, sys
helper, root, mode, format = sys.argv[1:]
format = int(format)
root = pathlib.Path(root)
os.chdir(root)
spec = importlib.util.spec_from_file_location("restart_proof", helper)
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)
products = root / "Build Products"
app = products / "Debug-iphonesimulator/OpenClaw.app"
tests = app / "PlugIns/OpenClawTests.xctest"
data = root / "app data"
data.mkdir()
for bundle, identifier in [(app, "test.openclaw.app"), (tests, "test.openclaw.tests")]:
    bundle.mkdir(parents=True, exist_ok=True)
    (bundle / "fixture").write_bytes(b"unchanged executable")
    (bundle / "Info.plist").write_bytes(plistlib.dumps({"CFBundleExecutable": "fixture", "CFBundleIdentifier": identifier}))
target = {"BlueprintName": "OpenClawTests", "TestHostPath": "__TESTROOT__/Debug-iphonesimulator/OpenClaw.app",
     "TestBundlePath": "__TESTHOST__/PlugIns/OpenClawTests.xctest", "UITargetAppPath": "unused",
     "OnlyTestIdentifiers": ["OldSelection"], "SkipTestIdentifiers": ["AnotherSelection"],
     "TestingEnvironmentVariables": {"DYLD_FRAMEWORK_PATH": "__TESTROOT__/Debug-iphonesimulator"}}
document = {"OpenClawTests": target, "OpenClawLogicTests": {"BlueprintName": "OpenClawLogicTests"}}
if format == 2:
    document = {"TestConfigurations": [{"Name": "Default", "IsEnabled": True, "TestTargets": [
        {"BlueprintName": "OpenClawLogicTests"}, target]}]}
if format != 0:
    document["__xctestrun_metadata__"] = {"FormatVersion": format}
(products / "OpenClaw_iphonesimulator.xctestrun").write_bytes(plistlib.dumps(document))
commands, runs = [], []
phase = None
source = "a" * 40
def run(args, capture=False, env=None):
    global phase
    commands.append(args)
    if args[0] == "git":
        return source
    if "-showBuildSettings" in args:
        return json.dumps([{"target": "OpenClaw", "buildSettings": {
            "BUILD_DIR": str(products), "TARGET_BUILD_DIR": str(app.parent), "FULL_PRODUCT_NAME": app.name}}])
    if "test-without-building" in args:
        phase = env["TEST_RUNNER_OPENCLAW_ACCESS_RESTART_PHASE"]
        config = plistlib.loads(pathlib.Path(args[args.index("-xctestrun") + 1]).read_bytes())
        runs.append({"phase": phase, "config": config})
        if phase == "seed" and mode != "missing-handoff":
            nonce = env["TEST_RUNNER_OPENCLAW_ACCESS_RESTART_NONCE"]
            receipt = data / "Library/Application Support" / ("access-restart-" + nonce + ".plist")
            receipt.parent.mkdir(parents=True)
            receipt.write_bytes(plistlib.dumps({"nonce": nonce, "source": source, "bundleID": "test.openclaw.app",
                "container": str(data), "executableSHA256": hashlib.sha256((app / "fixture").read_bytes()).hexdigest(),
                "processID": 2147483647}))
        if phase == "verify" and mode == "changed-binary":
            (app / "fixture").write_bytes(b"replacement executable")
    if "xcresulttool" in args:
        if "summary" in args:
            count = 0 if mode == "zero-tests" else 1
            return json.dumps({"result": "Passed", "totalTestCount": count, "passedTests": count,
                "failedTests": 0, "skippedTests": 1 if mode == "skipped" else 0,
                "expectedFailures": 0, "testFailures": []})
        name = phase.title()
        identifier = "WrongCase" if mode == "wrong-case" else f"GatewayAccessRestart{name}Tests/{phase} acknowledged sign out()"
        return json.dumps({"testNodes": [{"nodeType": "Test Case", "nodeIdentifier": identifier, "result": "Passed"}]})
    if "get_app_container" in args:
        return str(app if args[-1] == "app" else data)
    return ""
proof.run = run
proof.process_exists = lambda pid: mode == "live-seed"
ticks = iter([0, 10])
proof.time.monotonic = lambda: next(ticks)
error = None
with contextlib.redirect_stdout(io.StringIO()):
    try:
        proof.main("simulator-fixture")
    except Exception as failure:
        error = str(failure)
print(json.dumps({"error": error, "commands": commands, "runs": runs}))
`,
      path.resolve("scripts/ios-access-restart-proof.py"),
      root,
      mode,
      String(format),
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    error: string | null;
    commands: string[][];
    runs: {
      phase: string;
      config: {
        OpenClawTests?: Record<string, unknown>;
        OpenClawLogicTests?: Record<string, unknown>;
        TestConfigurations?: { TestTargets: Record<string, unknown>[] }[];
        __xctestrun_metadata__?: { FormatVersion: number };
      };
    }[];
  };
}

describe("iOS Access process restart proof", () => {
  it.each([0, 1, 2])(
    "preserves format %s and verifies destination artifacts without another install",
    (format) => {
      const { error, commands, runs } = runRestartProof("ready", format);
      expect(error).toBeNull();
      expect(runs.map((run) => run.phase)).toEqual(["seed", "verify"]);
      const targets = (config: (typeof runs)[number]["config"]) =>
        format === 2 ? config.TestConfigurations![0]!.TestTargets : [config.OpenClawTests!];
      const seed = targets(runs[0]!.config);
      const verify = targets(runs[1]!.config);
      for (const { config } of runs) {
        expect(config.__xctestrun_metadata__?.FormatVersion).toBe(format || undefined);
        expect(config).not.toHaveProperty("OpenClawLogicTests");
        if (format !== 2) {
          expect(config).not.toHaveProperty("TestConfigurations");
        }
      }
      expect(seed).toHaveLength(1);
      expect(verify).toHaveLength(1);
      expect(verify[0]).toMatchObject({
        BlueprintName: "OpenClawTests",
        UseDestinationArtifacts: true,
        TestHostBundleIdentifier: "test.openclaw.app",
        TestBundleDestinationRelativePath: "__TESTHOST__/PlugIns/OpenClawTests.xctest",
        TestingEnvironmentVariables: seed[0]!.TestingEnvironmentVariables,
      });
      for (const key of ["OnlyTestIdentifiers", "SkipTestIdentifiers"]) {
        expect(seed[0]).not.toHaveProperty(key);
        expect(verify[0]).not.toHaveProperty(key);
      }
      for (const key of ["TestHostPath", "TestBundlePath", "UITargetAppPath"]) {
        expect(verify[0]).not.toHaveProperty(key);
      }
      const phases = commands.filter((args) => args.includes("test-without-building"));
      expect(phases.map((args) => args.find((arg) => arg.startsWith("-only-testing:")))).toEqual([
        "-only-testing:OpenClawTests/GatewayAccessRestartSeedTests",
        "-only-testing:OpenClawTests/GatewayAccessRestartVerifyTests",
      ]);
      for (const args of phases) {
        expect(args).toContain("platform=iOS Simulator,id=simulator-fixture");
      }
      expect(commands.filter((args) => args.includes("build-for-testing"))).toHaveLength(1);
      expect(commands.some((args) => args.includes("install") || args.includes("uninstall"))).toBe(
        false,
      );
    },
  );

  it("rejects an unknown generated format before either process starts", () => {
    const { error, runs } = runRestartProof("ready", 3);
    expect(error).toBe("Unsupported generated test run format");
    expect(runs).toEqual([]);
  });

  it.each([
    "zero-tests",
    "skipped",
    "wrong-case",
    "missing-handoff",
    "changed-binary",
    "live-seed",
  ])("rejects %s without claiming restart proof", (mode) => {
    const { error, runs, commands } = runRestartProof(mode);
    expect(error).toBeTruthy();
    expect(runs.map((run) => run.phase)).toEqual(
      mode === "changed-binary" ? ["seed", "verify"] : ["seed"],
    );
    if (mode === "live-seed") {
      expect(commands).toContainEqual([
        "xcrun",
        "simctl",
        "terminate",
        "simulator-fixture",
        "test.openclaw.app",
      ]);
    }
  });
});
