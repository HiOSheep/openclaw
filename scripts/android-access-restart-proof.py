#!/usr/bin/env python3
"""Run two selected app-process tests against the same installed Debug APKs."""

import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid


APP = "ai.openclaw.app.debug"
TEST_CLASS = "ai.openclaw.app.gateway.CloudflareAccessRestartNativeTest"
ADB = ["adb", "-s", "emulator-5554"]


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(arguments, check=True, timeout=30):
    return subprocess.run(arguments, check=check, capture_output=True, text=True, timeout=timeout)


def digest(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def selected_apk(directory, variant, application):
    metadata = json.loads((directory / "output-metadata.json").read_text())
    require(metadata["variantName"] == variant and metadata["applicationId"] == application,
            "Unexpected APK variant or application")
    require(metadata["artifactType"]["type"] == "APK" and len(metadata["elements"]) == 1,
            "Expected one selected APK")
    element = metadata["elements"][0]
    filename = element["outputFile"]
    require(not element["filters"] and Path(filename).name == filename and filename.endswith(".apk"),
            "Expected one universal APK basename")
    return directory / filename


def phase_receipt(output, method):
    statuses, current, terminal, receipts = [], {}, [], []
    for line in output.splitlines():
        if line.startswith("INSTRUMENTATION_STATUS: "):
            key, value = line.removeprefix("INSTRUMENTATION_STATUS: ").split("=", 1)
            current[key] = value
        elif line.startswith("INSTRUMENTATION_STATUS_CODE: "):
            statuses.append((int(line.removeprefix("INSTRUMENTATION_STATUS_CODE: ")), current))
            current = {}
        elif line.startswith("INSTRUMENTATION_RESULT: accessRestartReceipt="):
            receipts.append(json.loads(line.split("=", 1)[1]))
        elif line.startswith("INSTRUMENTATION_CODE: "):
            terminal.append(int(line.removeprefix("INSTRUMENTATION_CODE: ")))
    require([code for code, _ in statuses] == [1, 0] and terminal == [-1] and len(receipts) == 1,
            "Restart phase must execute exactly one passing test with no skips")
    for _, status in statuses:
        require(status.get("class") == TEST_CLASS and status.get("test") == method
                and status.get("numtests") == "1" and status.get("current") == "1",
                "Wrong or duplicate restart case executed")
    return receipts[0]


def main(apk, evidence):
    source = run(["git", "rev-parse", "HEAD"]).stdout.strip()
    require(re.fullmatch(r"[0-9a-f]{40}", source), "Missing source identity")
    selected = selected_apk(Path("apps/android/app/build/outputs/apk/play/debug"), "playDebug", APP)
    require(apk.resolve() == selected.resolve(), "Restart app differs from the original qualified APK")
    test_apk = selected_apk(Path("apps/android/app/build/outputs/apk/androidTest/play/debug"), "playDebugAndroidTest", APP + ".test")
    app_digest, test_digest = digest(apk), digest(test_apk)
    nonce = str(uuid.uuid4())
    evidence.mkdir(parents=True, exist_ok=True)
    # The preceding connected run uninstalls its APKs. Install these exact products once.
    for binary in (apk, test_apk):
        run(ADB + ["install", "-r", str(binary)], timeout=60)
    component = APP + ".test/androidx.test.runner.AndroidJUnitRunner"
    installed = run(ADB + ["shell", "pm", "list", "instrumentation", APP]).stdout.splitlines()
    require(f"instrumentation:{component} (target={APP})" in installed, "Expected installed target instrumentation")

    def phase(name, method):
        command = ["/usr/bin/timeout", "--signal=TERM", "--kill-after=2s", "60s"] + ADB + [
            "shell", "am", "instrument", "-r", "-w", "-e", "class", TEST_CLASS + "#" + method,
            "-e", "restartPhase", name, "-e", "restartNonce", nonce, "-e", "restartSource", source,
            "-e", "restartApkSha256", app_digest, component,
        ]
        try:
            result = run(command, check=False, timeout=65)
        except subprocess.TimeoutExpired as error:
            # Preserve partial runner output even if the outer host deadline fires.
            result = subprocess.CompletedProcess(command, 124,
                                                 (error.stdout or b"").decode(errors="replace"),
                                                 (error.stderr or b"").decode(errors="replace"))
        (evidence / f"restart-{name}.stdout").write_text(result.stdout)
        (evidence / f"restart-{name}.stderr").write_text(result.stderr)
        (evidence / f"restart-{name}.status").write_text(str(result.returncode) + "\n")
        require(result.returncode == 0, f"Restart {name} host command failed")
        receipt = phase_receipt(result.stdout, method)
        require(receipt.get("phase") == name and receipt.get("nonce") == nonce and receipt.get("source") == source,
                "Restart phase handoff mismatch")
        require(receipt.get("package") == APP and receipt.get("process") == APP and receipt.get("apk") == app_digest,
                "Restart phase did not execute the selected app")
        require(type(receipt.get("pid")) is int and receipt["pid"] > 1 and type(receipt.get("uid")) is int,
                "Missing app process identity")
        require(type(receipt.get("bootstrapExpiresAtMs")) is int and receipt["bootstrapExpiresAtMs"] > 0,
                "Missing absolute bootstrap deadline")
        for key in ("signer", "storage", "instance"):
            require(re.fullmatch(r"[0-9a-f]{64}", receipt.get(key, "")), "Missing signing or storage identity")
        return receipt

    seed = phase("seed", "seedAcknowledgedSignOut")
    # Instrumentation.finish ends the target process. Never clear data or reinstall between phases.
    deadline = time.monotonic() + 5
    while True:
        result = run(ADB + ["shell", "pidof", APP], check=False)
        require(result.returncode in (0, 1) and not result.stderr.strip(), "Could not observe the seed app process")
        pids = result.stdout.split()
        require(all(value.isdecimal() and int(value) > 1 for value in pids), "Invalid app process result")
        require((result.returncode == 1) == (not pids), "Inconsistent app process result")
        if not pids:
            break
        require(time.monotonic() < deadline, "Seed app process did not exit")
        time.sleep(0.1)
    verified = phase("verify", "verifyAcknowledgedSignOut")
    require(verified["pid"] != seed["pid"] and verified.get("seedPid") == seed["pid"], "App process was not restarted")
    for key in ("nonce", "source", "uid", "package", "process", "apk", "signer", "storage", "instance", "bootstrapExpiresAtMs"):
        require(seed[key] == verified[key], f"Restart {key} identity changed")
    require(digest(apk) == app_digest and digest(test_apk) == test_digest, "Built APK changed during restart proof")
    (evidence / "restart.json").write_text(json.dumps({"seed": seed, "verify": verified, "testApk": test_digest, "seedProcessExited": True}, indent=2) + "\n")
    print(f"ACCESS_RESTART passed source={source} seed_pid={seed['pid']} verify_pid={verified['pid']} app_sha256={app_digest}")


if __name__ == "__main__":
    try:
        require(len(sys.argv) == 3, "Expected qualified app APK and evidence directory")
        main(Path(sys.argv[1]), Path(sys.argv[2]))
    except Exception as error:
        print(str(error), file=sys.stderr)
        print("[android-access-restart] FAILED (exit 1)", file=sys.stderr)
        sys.exit(1)
