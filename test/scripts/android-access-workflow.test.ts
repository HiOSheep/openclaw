import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
const job = workflow.jobs["android-access-native"];
const step = job.steps.find(
  (entry: { name?: string }) => entry.name === "Run packaged Access crypto on Android",
);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function verifyReports(mode: string, buildType: "Debug" | "Release" = "Debug") {
  const root = tempDirs.make("openclaw-access-reports-");
  const verification = step.run.split("python3 - <<'PY'\n")[1]?.split("\nPY")[0];
  if (!verification) {
    throw new Error("Missing native report verification");
  }
  return spawnSync(
    "python3",
    [
      "-c",
      String.raw`
from pathlib import Path
import json, os, sys, zipfile
mode = sys.argv[1]
build_type = os.environ['BUILD_TYPE']
module = os.environ['ACCESS_NATIVE_TEST_MODULE']
if mode == 'wrong-module': module = 'app' if module == 'access-native-test' else 'access-native-test'
reports = Path(f'apps/android/{module}/build/outputs/androidTest-results/connected') / build_type.lower()
reports.mkdir(parents=True)
names = os.environ['ACCESS_NATIVE_TEST_CLASSES'].split(',')
if mode == 'wrong-class': names[0] = 'OtherTest'
if mode == 'missing-store': names = names[:1]
if mode == 'duplicate': names.append(names[0])
child = '<failure/>' if mode == 'failed' else '<error/>' if mode == 'error' else '<skipped/>' if mode == 'skipped' else ''
cases = '' if mode == 'empty' else ''.join(f'<testcase classname="{name}" name="native">{child}</testcase>' for name in names)
(reports / 'TEST-device.xml').write_text(f'<testsuite>{cases}</testsuite>')
apk = Path(f'apps/android/app/build/outputs/apk/play/{build_type.lower()}/openclaw-2099.1.2-play-{build_type.lower()}.apk')
apk.parent.mkdir(parents=True)
element = {'outputFile': '../outside.apk' if mode == 'outside-output' else apk.name, 'filters': []}
metadata = {'variantName': 'thirdPartyDebug' if mode == 'wrong-variant' else f'play{build_type}',
            'artifactType': {'type': 'APK'}, 'elements': [element, element] if mode == 'ambiguous-output' else [element]}
(apk.parent / 'output-metadata.json').write_text(json.dumps(metadata))
abis = ['armeabi-v7a', 'arm64-v8a', 'x86', 'x86_64']
if mode == 'missing-abi': abis.pop()
with zipfile.ZipFile(apk, 'w') as archive:
    for abi in abis: archive.writestr(f'lib/{abi}/libsodium.so', b'test-only')
` + verification,
      mode,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        BUILD_TYPE: buildType,
        ACCESS_NATIVE_TEST_MODULE: buildType === "Release" ? "access-native-test" : "app",
        ACCESS_NATIVE_TEST_CLASSES:
          buildType === "Release"
            ? "ai.openclaw.app.gateway.CloudflareAccessReleaseNativeTest"
            : "ai.openclaw.app.gateway.CloudflareAccessNativeTest,ai.openclaw.app.gateway.CloudflareAccessPersistenceNativeTest",
      },
    },
  );
}

describe("Android Access native workflow", () => {
  it("runs the packaged class on current Android targets and includes its result in CI", () => {
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job.if).toContain("run_android_job == 'true'");
    expect(job.if).toContain("compatibility_target != 'true'");
    expect(step.run).toContain("gradle_tasks=(:app:connectedPlayDebugAndroidTest)");
    expect(step.run).toContain('"${gradle_tasks[@]}" "${gradle_args[@]}"');
    expect(step.run).toContain('"$native_test_filter"');
    expect(step.run).toContain(
      'native_test_filter="-Pandroid.testInstrumentationRunnerArguments.class=$ACCESS_NATIVE_TEST_CLASSES"',
    );
    expect(step.run).toContain('zipalign" -c -P 16 -v 4');
    expect(step.run).toContain('zipalign" -c -P 16 -v 4 "$apk"');
    expect(workflow.jobs["ci-gate"].needs).toContain("android-access-native");
    expect(workflow.jobs["ci-gate"].steps[0].env.JOB_RESULTS).toContain(
      "android-access-native=${{ needs.android-access-native.result }}|",
    );
  });

  it("selects both Debug methods through AGP's comma-separated arguments and adb shell quoting", () => {
    const assignment = step.run
      .split("\n")
      .find((line: string) => line.startsWith("native_test_filter="));
    expect(assignment).toBeDefined();
    const result = spawnSync("bash", ["-c", `${assignment}\nprintf '%s' "$native_test_filter"`], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const prefix = "-Pandroid.testInstrumentationRunnerArguments.tests_regex=";
    expect(result.stdout.startsWith(prefix)).toBe(true);
    const value = result.stdout.slice(prefix.length);
    expect(value).not.toContain(",");
    expect(value.startsWith("'") && value.endsWith("'")).toBe(true);
    const remote = spawnSync("bash", ["-c", `printf '%s' ${value}`], { encoding: "utf8" });
    expect(remote.status, remote.stderr).toBe(0);
    expect(remote.stdout.startsWith("^") && remote.stdout.endsWith("$")).toBe(true);
    const selection = new RegExp(remote.stdout);
    const methods = [
      "ai.openclaw.app.gateway.CloudflareAccessNativeTest#packagedSodiumLoadsAndDecryptsTheGoTransferVector",
      "ai.openclaw.app.gateway.CloudflareAccessPersistenceNativeTest#encryptedGrantRestoresAndDeletesWithoutChangingGatewayPairing",
    ];
    for (const method of methods) {
      expect(selection.test(method)).toBe(true);
      expect(selection.test(`other.${method}`)).toBe(false);
      expect(selection.test(`${method}Extra`)).toBe(false);
      expect(selection.test(method.replace(/#.+$/, "#otherMethod"))).toBe(false);
    }
  });

  it("isolates the Release runner from the app's optimized dependencies", () => {
    expect(step.env.BUILD_TYPE).toBe("${{ matrix.build-type }}");
    expect(step.run).toContain(
      "gradle_tasks=(:access-native-test:ktlintCheck :access-native-test:connectedReleaseAndroidTest)",
    );
    expect(step.run).toContain("gradle_args+=(--no-build-cache --info)");
    expect(step.run).not.toContain("init-script");
    expect(step.run).not.toContain("leaveApksInstalledAfterRun");
    expect(step.run).not.toContain("shell am instrument");
    expect(step.run).toContain("^> Task :app:minifyPlayReleaseWithR8$");
    expect(step.run).toContain("outputs/mapping/playRelease/configuration.txt");
    const module = readFileSync("apps/android/access-native-test/build.gradle.kts", "utf8");
    expect(module).toContain("alias(libs.plugins.android.test)");
    expect(module).toContain('targetProjectPath = ":app"');
    expect(module).toContain('create("release")');
    expect(module).toContain('beforeVariants(selector().withBuildType("debug"))');
    expect(module).toContain("variant.enable = false");
    expect(module).toContain('signingConfig = signingConfigs.getByName("debug")');
    expect(module).toContain('missingDimensionStrategy("store", "play")');
    expect(module).toContain(
      'experimentalProperties["android.experimental.self-instrumenting"] = true',
    );
    expect(module).toContain("implementation(libs.androidx.test.runner)");
    expect(module).not.toMatch(/(?:implementation|api|compileOnly)\s*\(\s*project/);
    expect(module).not.toMatch(/jna|sodium/i);
    const fixture = readFileSync(
      "apps/android/access-native-test/src/main/java/ai/openclaw/app/gateway/CloudflareAccessReleaseNativeTest.kt",
      "utf8",
    );
    expect(fixture).toContain("ApplicationInfo.FLAG_DEBUGGABLE");
    expect(fixture).toContain("Context.CONTEXT_INCLUDE_CODE or Context.CONTEXT_IGNORE_SECURITY");
    expect(fixture).toContain("assertThrows(ClassNotFoundException::class.java)");
    expect(fixture).toContain("assertSame(targetLoader, sodium.javaClass.classLoader)");
    expect(fixture).not.toContain("import com.sun.jna");
    expect(fixture).not.toContain("CloudflareAccessBox");
    const appRules = readFileSync("apps/android/app/proguard-rules.pro", "utf8");
    expect(appRules).not.toContain("androidx.tracing.Trace");
    expect(readFileSync("apps/android/app/build.gradle.kts", "utf8")).not.toContain(
      "testProguardFile",
    );
  });

  it("retains bounded original runner diagnostics before qualifying XML", () => {
    const log = step.run.indexOf("logcat -d -v brief -t 500");
    const verification = step.run.indexOf('apk="$(python3');
    expect(log).toBeGreaterThan(0);
    expect(log).toBeLessThan(verification);
    expect(step.run.slice(log - 100, log)).toContain("--kill-after=2s 30s adb -s emulator-5554");
    expect(step.run).toContain("AndroidRuntime:E ActivityManager:W '*:S'");
    const upload = job.steps.find(
      (entry: { name?: string }) => entry.name === "Upload Access native test reports",
    );
    expect(upload.with.path).toContain(
      "apps/android/access-native-test/build/outputs/androidTest-results/connected/**",
    );
    expect(upload.with.path).toContain("access-native-evidence/**");
  });

  it("runs restart proof only after the original Debug cases and APK alignment qualify", () => {
    const alignment = step.run.indexOf('zipalign" -c -P 16 -v 4 "$apk"');
    const restart = step.run.indexOf("python3 scripts/android-access-restart-proof.py");
    expect(restart).toBeGreaterThan(alignment);
    expect(step.run.slice(alignment, restart)).toContain('if [[ "$BUILD_TYPE" == Debug ]]; then');
    expect(step.run.slice(restart)).toContain('"$apk" "$RUNNER_TEMP/access-native-evidence"');
    expect(step.run).toContain("trap 'adb -s emulator-5554 emu kill");
    const fixture = readFileSync(
      "apps/android/app/src/androidTest/java/ai/openclaw/app/gateway/CloudflareAccessRestartNativeTest.kt",
      "utf8",
    );
    expect(fixture).toContain("@Test fun seedAcknowledgedSignOut()");
    expect(fixture).toContain("@Test fun verifyAcknowledgedSignOut()");
    expect(fixture).toContain(
      'assumeTrue("Requires the two-process restart runner", arguments.containsKey("restartPhase"))',
    );
  });

  it("requires ordinary and strict simulated 16 KiB packaged execution", () => {
    expect(job.strategy).toEqual({
      "fail-fast": false,
      matrix: {
        include: [
          { "page-size": 4096, image: "google_apis", "build-type": "Debug" },
          { "page-size": 16384, image: "google_apis_ps16k", "build-type": "Debug" },
          { "page-size": 4096, image: "google_apis", "build-type": "Release" },
          { "page-size": 16384, image: "google_apis_ps16k", "build-type": "Release" },
        ],
      },
    });
    expect(step.env.EXPECTED_PAGE_SIZE).toBe("${{ matrix.page-size }}");
    expect(step.env.SYSTEM_IMAGE).toBe("system-images;android-36;${{ matrix.image }};x86_64");
    expect(step.run).toContain(
      '-Pandroid.testInstrumentationRunnerArguments.expectedPageSize="$EXPECTED_PAGE_SIZE"',
    );
    const guard = step.run.slice(
      step.run.indexOf('test "$(adb -s emulator-5554 shell getconf PAGE_SIZE'),
      step.run.indexOf("gradle_args=()"),
    );
    expect(guard).toContain("setprop bionic.linker.16kb.app_compat.enabled false");
    expect(guard).toContain("setprop pm.16kb.app_compat.disabled true");
    for (const [pageSize, linker, packageManager, passes] of [
      [16384, "false", "true", true],
      [4096, "false", "true", false],
      [16384, "true", "true", false],
      [16384, "false", "false", false],
    ] as const) {
      const result = spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail
EXPECTED_PAGE_SIZE=16384
adb() {
  case "$*" in
    *"getconf PAGE_SIZE") echo ${pageSize} ;;
    *"getprop bionic.linker.16kb.app_compat.enabled") echo ${linker} ;;
    *"getprop pm.16kb.app_compat.disabled") echo ${packageManager} ;;
  esac
}
${guard}`,
        ],
        { encoding: "utf8" },
      );
      expect(result.status === 0, result.stderr).toBe(passes);
    }
  });

  it.each(["Debug", "Release"] as const)(
    "accepts executed %s native tests and all four packaged ABIs",
    (buildType) => {
      const result = verifyReports("passed", buildType);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(
        `apps/android/app/build/outputs/apk/play/${buildType.toLowerCase()}/openclaw-2099.1.2-play-${buildType.toLowerCase()}.apk`,
      );
    },
  );

  it.each([
    "empty",
    "duplicate",
    "missing-store",
    "error",
    "wrong-class",
    "failed",
    "skipped",
    "missing-abi",
    "wrong-variant",
    "ambiguous-output",
    "outside-output",
    "wrong-module",
  ])("rejects %s evidence even when Gradle returned success", (mode) => {
    for (const buildType of mode === "missing-store"
      ? (["Debug"] as const)
      : (["Debug", "Release"] as const)) {
      const result = verifyReports(mode, buildType);
      expect(result.status, `${buildType}: ${result.stderr}`).not.toBe(0);
    }
  });
});

function runRestartProof(mode = "ready") {
  const root = tempDirs.make("openclaw-android-restart-");
  const result = spawnSync(
    "python3",
    [
      "-B",
      "-c",
      String.raw`
import contextlib, hashlib, importlib.util, io, json, os, pathlib, subprocess, sys
helper, root, mode = sys.argv[1:]
root = pathlib.Path(root)
os.chdir(root)
spec = importlib.util.spec_from_file_location("restart_proof", helper)
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)
app = pathlib.Path("apps/android/app/build/outputs/apk/play/debug/app.apk")
test = pathlib.Path("apps/android/app/build/outputs/apk/androidTest/play/debug/test.apk")
for apk, variant, package in [(app, "playDebug", "ai.openclaw.app.debug"), (test, "playDebugAndroidTest", "ai.openclaw.app.debug.test")]:
    if mode == "namespace-package" and apk == app: package = "ai.openclaw.app"
    if mode == "wrong-test-package" and apk == test: package = "ai.openclaw.app.test"
    apk.parent.mkdir(parents=True)
    apk.write_bytes(b"unchanged test fixture apk" + package.encode())
    element = {"outputFile": "../outside.apk" if mode == "outside-apk" else apk.name, "filters": []}
    metadata = {"variantName": variant, "applicationId": package, "artifactType": {"type": "APK"},
                "elements": [element, element] if mode == "ambiguous-apk" else [element]}
    (apk.parent / "output-metadata.json").write_text(json.dumps(metadata))
commands = []
def run(args, check=True, timeout=30):
    commands.append(args)
    output, status, stderr = "", 0, ""
    if args[0] == "git": output = "a" * 40
    elif "instrumentation" in args:
        output = "" if mode == "missing-target" else "instrumentation:ai.openclaw.app.debug.test/androidx.test.runner.AndroidJUnitRunner (target=ai.openclaw.app.debug)\n"
    elif "pidof" in args:
        output, status = ("1234", 0) if mode == "seed-live" else ("", 1)
    elif "instrument" in args:
        phase = args[args.index("restartPhase") + 1]
        method = args[args.index("class") + 1].split("#")[1]
        receipt = {"nonce": args[args.index("restartNonce") + 1], "source": args[args.index("restartSource") + 1],
                   "pid": 1234 if phase == "seed" or mode == "same-pid" else 2345, "uid": 10123,
                   "package": "ai.openclaw.app.debug", "process": "ai.openclaw.app.debug", "apk": hashlib.sha256(app.read_bytes()).hexdigest(),
                   "signer": "b" * 64, "storage": "c" * 64, "instance": "d" * 64, "phase": phase,
                   "bootstrapExpiresAtMs": 1800000000000}
        if phase == "verify": receipt["seedPid"] = 1234
        if mode == "missing-deadline": del receipt["bootstrapExpiresAtMs"]
        if mode == "deadline-bool": receipt["bootstrapExpiresAtMs"] = True
        if mode == "deadline-string": receipt["bootstrapExpiresAtMs"] = "1800000000000"
        if mode == "deadline-zero": receipt["bootstrapExpiresAtMs"] = 0
        if phase == "verify" and mode == "changed-deadline": receipt["bootstrapExpiresAtMs"] += 1
        if mode == "wrong-source": receipt["source"] = "f" * 40
        if phase == "verify" and mode in ("changed-storage", "changed-signer"):
            receipt[mode.removeprefix("changed-")] = "e" * 64
        test_name = "anotherMethod" if mode == "wrong-case" else method
        test_class = "ai.openclaw.app.debug.gateway.CloudflareAccessRestartNativeTest" if mode == "wrong-test-class" else "ai.openclaw.app.gateway.CloudflareAccessRestartNativeTest"
        fields = f"INSTRUMENTATION_STATUS: class={test_class}\nINSTRUMENTATION_STATUS: test={test_name}\nINSTRUMENTATION_STATUS: numtests=1\nINSTRUMENTATION_STATUS: current=1\n"
        codes = [] if mode == "empty" else [1, -3 if mode == "skipped" else -4 if mode == "assumption" else -2 if mode == "failed" else 0]
        if mode == "duplicate": codes += [1, 0]
        output = "".join(fields + f"INSTRUMENTATION_STATUS_CODE: {code}\n" for code in codes)
        if mode != "missing-receipt": output += "INSTRUMENTATION_RESULT: accessRestartReceipt=" + json.dumps(receipt) + "\n"
        output += "INSTRUMENTATION_CODE: -1\n"
        if mode == "host-timeout": status, stderr = 124, "bounded host timeout"
        if mode == "outer-timeout": raise subprocess.TimeoutExpired(args, timeout, output.encode(), b"outer host timeout")
    return subprocess.CompletedProcess(args, status, output, stderr)
proof.run = run
ticks = iter([0, 10])
proof.time.monotonic = lambda: next(ticks)
error = None
evidence = pathlib.Path("evidence")
with contextlib.redirect_stdout(io.StringIO()):
    try: proof.main(app, evidence)
    except Exception as failure: error = str(failure)
files = {p.name: p.read_text() for p in evidence.glob("*")}
print(json.dumps({"error": error, "commands": commands, "files": files}))
`,
      path.resolve("scripts/android-access-restart-proof.py"),
      root,
      mode,
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    error: string | null;
    commands: string[][];
    files: Record<string, string>;
  };
}

describe("Android Access process restart proof", () => {
  it("installs once, observes process exit and qualifies two exact passing cases with retained evidence", () => {
    const { error, commands, files } = runRestartProof();
    expect(error).toBeNull();
    const invocations = commands.filter((args) => args.includes("instrument"));
    expect(invocations).toHaveLength(2);
    expect(invocations.map((args) => args[args.indexOf("class") + 1])).toEqual([
      "ai.openclaw.app.gateway.CloudflareAccessRestartNativeTest#seedAcknowledgedSignOut",
      "ai.openclaw.app.gateway.CloudflareAccessRestartNativeTest#verifyAcknowledgedSignOut",
    ]);
    for (const invocation of invocations) {
      expect(invocation.at(-1)).toBe(
        "ai.openclaw.app.debug.test/androidx.test.runner.AndroidJUnitRunner",
      );
      expect(invocation.slice(0, 7)).toEqual([
        "/usr/bin/timeout",
        "--signal=TERM",
        "--kill-after=2s",
        "60s",
        "adb",
        "-s",
        "emulator-5554",
      ]);
    }
    const first = commands.indexOf(invocations[0]!);
    const second = commands.indexOf(invocations[1]!);
    expect(commands.slice(0, first).filter((args) => args.includes("install"))).toHaveLength(2);
    expect(
      commands
        .slice(first)
        .some((args) =>
          args.some((arg) => ["install", "uninstall", "clear", "force-stop"].includes(arg)),
        ),
    ).toBe(false);
    expect(commands.slice(first + 1, second)).toContainEqual([
      "adb",
      "-s",
      "emulator-5554",
      "shell",
      "pidof",
      "ai.openclaw.app.debug",
    ]);
    for (const phase of ["seed", "verify"]) {
      expect(files[`restart-${phase}.status`]).toBe("0\n");
      expect(files[`restart-${phase}.stderr`]).toBe("");
      expect(files[`restart-${phase}.stdout`]).toContain("INSTRUMENTATION_STATUS_CODE: 0");
    }
    const receipt = JSON.parse(files["restart.json"]!);
    expect(receipt.seedProcessExited).toBe(true);
    expect(receipt.seed.pid).not.toBe(receipt.verify.pid);
    expect(receipt.seed.storage).toBe(receipt.verify.storage);
    expect(receipt.seed.apk).toBe(receipt.verify.apk);
    expect(receipt.seed.bootstrapExpiresAtMs).toBe(1800000000000);
    expect(receipt.verify.bootstrapExpiresAtMs).toBe(receipt.seed.bootstrapExpiresAtMs);
    expect(receipt.testApk).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    "empty",
    "skipped",
    "assumption",
    "failed",
    "duplicate",
    "wrong-case",
    "wrong-test-class",
    "missing-receipt",
    "wrong-source",
    "seed-live",
    "same-pid",
    "changed-storage",
    "changed-signer",
    "missing-deadline",
    "deadline-bool",
    "deadline-string",
    "deadline-zero",
    "changed-deadline",
    "missing-target",
    "namespace-package",
    "wrong-test-package",
    "outside-apk",
    "ambiguous-apk",
    "host-timeout",
    "outer-timeout",
  ])("rejects %s without claiming restart proof", (mode) => {
    const { error, commands, files } = runRestartProof(mode);
    expect(error).toBeTruthy();
    expect(files).not.toHaveProperty("restart.json");
    const expected = ["same-pid", "changed-storage", "changed-signer", "changed-deadline"].includes(
      mode,
    )
      ? 2
      : [
            "missing-target",
            "namespace-package",
            "wrong-test-package",
            "outside-apk",
            "ambiguous-apk",
          ].includes(mode)
        ? 0
        : 1;
    expect(commands.filter((args) => args.includes("instrument"))).toHaveLength(expected);
    if (mode === "host-timeout") {
      expect(files["restart-seed.status"]).toBe("124\n");
      expect(files["restart-seed.stderr"]).toBe("bounded host timeout");
    }
    if (mode === "outer-timeout") {
      expect(files["restart-seed.status"]).toBe("124\n");
      expect(files["restart-seed.stderr"]).toBe("outer host timeout");
      expect(files["restart-seed.stdout"]).toContain("INSTRUMENTATION_STATUS_CODE: 0");
    }
  });
});
