/* oxlint-disable t3code/no-global-process-runtime -- Standalone native service tooling outside the Effect application. */
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeNet from "node:net";
import * as NodeEvents from "node:events";
import * as NodeTest from "node:test";
import { nativeManage, nativeRecovery } from "./lib/ko-deployment-native.mjs";
import {
  platformAdapter,
  renderLaunchd,
  renderWindowsTask,
  renderWindowsScript,
  windowsArgument,
} from "./lib/ko-service-platforms.mjs";
import { atomicJson, run } from "./lib/ko-release.mjs";
import { smoke } from "./lib/ko-deployment.mjs";

function setup(t, platform = "win32") {
  const temporary = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ko-native-test-"));
  t.after(() => NodeFS.rmSync(temporary, { recursive: true, force: true }));
  const c = {
    platform,
    root: NodePath.join(temporary, "deploy"),
    baseDir: NodePath.join(temporary, "live"),
    node: process.execPath,
    unitDirectory: NodePath.join(temporary, "units"),
    service: `ko-native-test-${process.pid}`,
    port: 3773,
    baselineVersion: "0.0.42",
    userName: "MACHINE\\Bob",
  };
  const releaseId = "0.0.42-ko-aaaaaaaaaaaa";
  const target = NodePath.join(c.root, "releases", releaseId);
  NodeFS.mkdirSync(NodePath.join(target, "node_modules/t3/dist/client"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(target, "node_modules/t3/dist/client/index.html"),
    "test release",
  );
  return { c, releaseId, target };
}
NodeTest.test(
  "launchd preserves operator PATH and logs while removing inherited upstream launcher ownership",
  () => {
    const c = {
      service: "com.t3tools.t3code.service",
      node: "/opt/node",
      baseDir: "/Users/bob/.t3",
      root: "/Users/bob/fork",
    };
    const result = renderLaunchd(c, "/Users/bob/release", {
      Label: c.service,
      Program: "/old/launcher",
      EnvironmentVariables: {
        PATH: "/custom/bin",
        T3_BOOT_SERVICE_UNIT: "old",
        T3_SERVICE_LAUNCHER_CONTEXT: "private",
      },
      StandardOutPath: "/logs/out",
      ThrottleInterval: 5,
    });
    NodeAssert.match(result, /<key>PATH<\/key><string>\/custom\/bin<\/string>/);
    NodeAssert.match(result, /<key>StandardOutPath<\/key><string>\/logs\/out<\/string>/);
    NodeAssert.match(result, /<key>T3_KO_MANAGED<\/key><string>1<\/string>/);
    NodeAssert.doesNotMatch(
      result,
      /T3_BOOT_SERVICE_UNIT|T3_SERVICE_LAUNCHER_CONTEXT|<key>Program<\/key>/,
    );
    NodeAssert.throws(() => renderLaunchd(c, "/release", { Label: "another.service" }), /label/);
  },
);
NodeTest.test(
  "Windows task is hidden, limited to the operator login, persistent and restarts on failure",
  () => {
    const c = { baseDir: "C:\\Users\\Bob & Co\\.t3" };
    const result = renderWindowsTask(c, "C:\\fork path\\t3.ps1", "S-1-5-21-1");
    NodeAssert.match(result, /<UserId>S-1-5-21-1<\/UserId>/);
    NodeAssert.match(result, /<LogonType>InteractiveToken<\/LogonType>/);
    NodeAssert.match(result, /<RunLevel>LeastPrivilege<\/RunLevel>/);
    NodeAssert.match(result, /<Hidden>true<\/Hidden>/);
    NodeAssert.match(result, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
    NodeAssert.match(result, /<RestartOnFailure><Interval>PT1M<\/Interval><Count>999<\/Count>/);
    NodeAssert.match(result, /Bob &amp; Co/);
    NodeAssert.equal(windowsArgument('a "quoted" path\\'), '"a \\"quoted\\" path\\\\"');
  },
);
NodeTest.test(
  "Windows launcher syntax safely preserves literal paths and clears upstream context",
  { skip: process.platform !== "win32" },
  (t) => {
    const { c, target } = setup(t);
    const script = renderWindowsScript(
      { ...c, baseDir: "C:\\a $literal (path)\\Bob's home" },
      target,
    );
    const scriptPath = NodePath.join(c.root, "syntax.ps1");
    NodeFS.writeFileSync(scriptPath, script);
    const check = `$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile('${scriptPath.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){throw ($errors|Out-String)}`;
    run("powershell.exe", [
      "-NoProfile",
      "-EncodedCommand",
      Buffer.from(check, "utf16le").toString("base64"),
    ]);
    NodeAssert.match(script, /CreateNoWindow = \$true/);
    NodeAssert.match(script, /Remove\('T3_SERVICE_LAUNCHER_CONTEXT'\)/);
    NodeAssert.match(script, /Bob''s home/);
  },
);
NodeTest.test("first installation rejects occupied port before changing any service", async (t) => {
  const { c, releaseId } = setup(t);
  let changed = false;
  await NodeAssert.rejects(
    nativeManage(c, "activate", releaseId, {
      adapter: {
        capture: () => ({ definition: null }),
        install: () => {
          changed = true;
        },
      },
      verify: () => ({ releaseId, version: c.baselineVersion }),
      smoke: async () => {},
      portFree: () => {
        throw new Error("occupied");
      },
    }),
    /occupied/,
  );
  NodeAssert.equal(changed, false);
  NodeAssert.equal(nativeRecovery(c).transaction, null);
});
NodeTest.test(
  "native activation failure restores the exact prior service and selection",
  async (t) => {
    const { c, releaseId } = setup(t, "darwin");
    const original = { definition: "original plist", script: null };
    const calls = [];
    let installed = false;
    await NodeAssert.rejects(
      nativeManage(c, "activate", releaseId, {
        adapter: {
          capture: () => original,
          info: () => ({ state: "active", pid: "42" }),
          install: () => {
            installed = true;
          },
          restore: (saved) => {
            NodeAssert.deepEqual(saved, original);
            calls.push("restore");
          },
        },
        verify: () => ({ releaseId, version: c.baselineVersion }),
        smoke: async () => {},
        indexHash: async () => "old-client",
        healthy: (_c, hash) => {
          if (hash !== "old-client") throw new Error("bad client");
          calls.push("old-healthy");
        },
      }),
      /previous service restored/,
    );
    NodeAssert.equal(installed, true);
    NodeAssert.deepEqual(calls, ["restore", "old-healthy"]);
    NodeAssert.equal(nativeRecovery(c).transaction.phase, "rolled-back");
    NodeAssert.equal(NodeFS.existsSync(NodePath.join(c.root, "current.json")), false);
  },
);
NodeTest.test(
  "first installation failure unregisters its service and recovery remains retryable after interruption",
  async (t) => {
    const { c, releaseId } = setup(t);
    let recovered = false;
    const adapter = {
      capture: () => ({ definition: null, script: null }),
      install: () => {},
      restore: (saved) => {
        NodeAssert.equal(saved.definition, null);
        recovered = true;
      },
    };
    await NodeAssert.rejects(
      nativeManage(c, "activate", releaseId, {
        adapter,
        verify: () => ({ releaseId, version: c.baselineVersion }),
        smoke: async () => {},
        portFree: async () => {},
        healthy: () => {
          throw new Error("interrupted");
        },
      }),
      /Activation and rollback failed/,
    );
    NodeAssert.equal(recovered, true);
    NodeAssert.equal(nativeRecovery(c).transaction.phase, "pending");
    await NodeAssert.rejects(
      nativeManage(c, "activate", releaseId, { adapter }),
      /Interrupted activation/,
    );
    await nativeManage(c, "rollback", undefined, {
      adapter,
      healthy: (_c, hash) => NodeAssert.equal(hash, null),
    });
    NodeAssert.equal(nativeRecovery(c).transaction.phase, "rolled-back");
  },
);
NodeTest.test(
  "native recovery identity includes platform and operator but permits Node and baseline upgrades",
  (t) => {
    const { c } = setup(t);
    atomicJson(NodePath.join(c.root, "activation.json"), { config: c, phase: "active" });
    NodeAssert.deepEqual(nativeRecovery({ ...c, userName: "OTHER\\Bob" }).configMismatch, [
      "userName",
    ]);
    NodeAssert.deepEqual(nativeRecovery({ ...c, platform: "darwin" }).configMismatch, ["platform"]);
    NodeAssert.deepEqual(
      nativeRecovery({ ...c, node: "/different/node", baselineVersion: "0.0.43" }).configMismatch,
      [],
    );
  },
);
NodeTest.test(
  "disposable native service starts a Node package and rolls back first installation",
  {
    skip: !["win32", "darwin"].includes(process.platform) || process.env.KO_TEST_NATIVE !== "1",
    timeout: 120000,
  },
  async (t) => {
    const { c, releaseId, target } = setup(t, process.platform);
    if (process.platform === "win32")
      c.userName = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
    else delete c.userName;
    const socket = NodeNet.createServer();
    socket.listen(0, "127.0.0.1");
    await NodeEvents.once(socket, "listening");
    c.port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    NodeFS.writeFileSync(
      NodePath.join(target, "node_modules/t3/dist/bin.mjs"),
      `import http from 'node:http';const arg=n=>process.argv[process.argv.indexOf(n)+1];http.createServer((req,res)=>res.end('test release')).listen(Number(arg('--port')),'127.0.0.1');`,
    );
    const adapter = platformAdapter(c);
    NodeAssert.equal(adapter.capture().definition, null);
    t.after(() => adapter.restore({ definition: null, script: null }));
    await nativeManage(c, "activate", releaseId, {
      smoke,
      verify: () => ({ releaseId, version: c.baselineVersion }),
    });
    NodeAssert.equal(nativeRecovery(c).transaction.phase, "active");
    NodeAssert.equal(adapter.info().state, "active");
    await nativeManage(c, "rollback");
    NodeAssert.equal(nativeRecovery(c).transaction.phase, "rolled-back");
    NodeAssert.equal(adapter.capture().definition, null);
  },
);
