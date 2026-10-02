import * as NodeAssert from "node:assert/strict";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import {
  atomicJson,
  digest,
  installRelease,
  readJson,
  run,
  verifyArchive,
  verifyInstalled,
} from "./lib/ko-release.mjs";
import { loadConfig, manage, readRecovery, status, waitHealthy } from "./lib/ko-deployment.mjs";

function fixture(root, marker, failure = false) {
  const source = NodePath.join(root, marker);
  const pkg = NodePath.join(source, "package");
  NodeFS.mkdirSync(NodePath.join(pkg, "dist/client"), { recursive: true });
  atomicJson(NodePath.join(pkg, "package.json"), {
    name: "t3",
    version: "0.0.40",
    type: "module",
    bin: { t3: "dist/bin.mjs" },
  });
  NodeFS.writeFileSync(NodePath.join(pkg, "dist/client/index.html"), `<html>${marker}</html>`);
  NodeFS.writeFileSync(
    NodePath.join(pkg, "dist/bin.mjs"),
    `import http from 'node:http';import fs from 'node:fs';
if(process.argv.includes('--help')){console.log('fixture help');process.exit(0)}
const arg=(name)=>process.argv[process.argv.indexOf(name)+1];
if(${failure} && arg('--base-dir').endsWith('/live'))process.exit(7);
const server=http.createServer((_req,res)=>res.end(fs.readFileSync(new URL('./client/index.html',import.meta.url))));
server.listen(Number(arg('--port')),'127.0.0.1');process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`,
  );
  run("tar", ["-czf", "t3-code.tgz", "package"], { cwd: source });
  const commit =
    marker === "old" ? "a".repeat(40) : marker === "good" ? "b".repeat(40) : "c".repeat(40);
  atomicJson(NodePath.join(source, "release.json"), {
    schemaVersion: 1,
    repository: "https://github.com/nobody0/t3code",
    commit,
    version: "0.0.40",
    releaseId: `0.0.40-ko-${commit.slice(0, 12)}-12345678`,
    artifact: "t3-code.tgz",
    sha256: digest(NodePath.join(source, "t3-code.tgz")),
    preview: false,
    dirty: false,
  });
  return source;
}
function temp(t) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ko-release-test-"));
  t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  return root;
}
function recoveryFixture(t) {
  const root = temp(t);
  const config = {
    root,
    baseDir: NodePath.join(root, "live"),
    unitDirectory: NodePath.join(root, "units"),
    service: "fixture.service",
    port: 3773,
    node: process.execPath,
    baselineVersion: "0.0.40",
  };
  const journal = {
    schemaVersion: 1,
    config,
    phase: "active",
    releaseId: "old",
    previous: { link: null, override: null, indexHash: "previous-client" },
  };
  atomicJson(NodePath.join(root, "activation.json"), journal);
  return { config, journal };
}
NodeTest.test(
  "completed recovery records allow version and Node changes regardless of key order",
  async (t) => {
    const { config, journal } = recoveryFixture(t);
    const changed = {
      ...Object.fromEntries(Object.entries(config).toReversed()),
      baselineVersion: "0.0.41",
      node: NodePath.join(config.root, "new-node"),
    };
    NodeAssert.deepEqual(readRecovery(changed).configMismatch, []);
    // Getting as far as the missing release proves the old journal did not block activation.
    await NodeAssert.rejects(manage(changed, "activate", "0.0.41-ko-aaaaaaaaaaaa"), {
      code: "ENOENT",
    });
    NodeAssert.deepEqual(readRecovery(changed).transaction, journal);
    NodeAssert.equal(
      NodeFS.readdirSync(config.root).some((name) => name.startsWith("history-")),
      false,
    );
  },
);
NodeTest.test("identity mismatches remain inspectable and reject mutations", async (t) => {
  const { config, journal } = recoveryFixture(t);
  for (const name of ["baseDir", "unitDirectory", "service", "port"]) {
    const changed = { ...config, [name]: name === "port" ? 9999 : `${config[name]}-other` };
    NodeAssert.deepEqual(readRecovery(changed), { transaction: journal, configMismatch: [name] });
    for (const operation of ["activate", "rollback"])
      await NodeAssert.rejects(manage(changed, operation, "next"), /Deployment identity changed/);
  }
  atomicJson(NodePath.join(config.root, "activation.json"), {
    ...journal,
    config: { ...config, root: NodePath.join(config.root, "other") },
  });
  NodeAssert.deepEqual(readRecovery(config).configMismatch, ["root"]);
  await NodeAssert.rejects(manage(config, "rollback"), /Deployment identity changed/);
});
NodeTest.test("interrupted rollback stays pending and can be retried", async (t) => {
  const { config, journal } = recoveryFixture(t);
  let restored = false;
  await NodeAssert.rejects(
    manage(config, "rollback", undefined, {
      restore: (_c, previous) => {
        NodeAssert.equal(readRecovery(config).transaction.phase, "pending");
        NodeAssert.deepEqual(previous, journal.previous);
        restored = true;
      },
      healthy: () => {
        throw new Error("recovery interrupted");
      },
    }),
    /recovery interrupted/,
  );
  NodeAssert.equal(restored, true);
  NodeAssert.equal(readRecovery(config).transaction.phase, "pending");
  await NodeAssert.rejects(
    manage({ ...config, baselineVersion: "0.0.41" }, "activate", "next"),
    /Interrupted activation or rollback/,
  );
  await manage(config, "rollback", undefined, {
    restore: (_c, previous) => NodeAssert.deepEqual(previous, journal.previous),
    healthy: (_c, hash) => NodeAssert.equal(hash, journal.previous.indexHash),
  });
  NodeAssert.equal(readRecovery(config).transaction.phase, "rolled-back");
  await NodeAssert.rejects(manage(config, "rollback"), /Already rolled back/);
});
NodeTest.test("accepts new release IDs and legacy origin hashes", (t) => {
  const source = fixture(temp(t), "good");
  const manifest = verifyArchive(source);
  atomicJson(NodePath.join(source, "release.json"), {
    ...manifest,
    releaseId: `${manifest.version}-ko-${manifest.commit.slice(0, 12)}`,
  });
  NodeAssert.equal(verifyArchive(source).commit, manifest.commit);
});
NodeTest.test("rejects previews, invalid IDs and corrupted archives before installing", (t) => {
  const root = temp(t),
    source = fixture(root, "good"),
    manifest = readJson(NodePath.join(source, "release.json"));
  for (const changes of [{ preview: true }, { releaseId: ".." }, { sha256: "0".repeat(64) }]) {
    atomicJson(NodePath.join(source, "release.json"), { ...manifest, ...changes });
    NodeAssert.throws(() => installRelease(source, NodePath.join(root, "installed")));
    NodeAssert.equal(NodeFS.existsSync(NodePath.join(root, "installed")), false);
  }
});
NodeTest.test("failed installs receive no completion receipt and cannot be reused", (t) => {
  const root = temp(t),
    source = fixture(root, "good"),
    manifest = verifyArchive(source),
    releases = NodePath.join(root, "releases");
  NodeAssert.throws(
    () =>
      installRelease(source, releases, () => {
        throw Error("npm failure");
      }),
    /npm failure/,
  );
  const target = NodePath.join(releases, manifest.releaseId);
  NodeAssert.equal(NodeFS.existsSync(NodePath.join(target, "installed.json")), false);
  NodeAssert.throws(() => verifyInstalled(target));
  NodeAssert.throws(() => installRelease(source, releases), /EEXIST/);
});
// Package installation runs on each target; systemd integration is Linux-only.
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone platform integration tests.
const linux = process.platform === "linux";
NodeTest.test("installs a runtime package and detects post-install changes", {}, (t) => {
  const root = temp(t),
    source = fixture(root, "good");
  const target = installRelease(source, NodePath.join(root, "releases"));
  NodeAssert.equal(verifyInstalled(target).version, "0.0.40");
  NodeAssert.throws(() => installRelease(source, NodePath.join(root, "releases")), /EEXIST/);
  NodeFS.appendFileSync(NodePath.join(target, "node_modules/t3/dist/bin.mjs"), "\n// changed\n");
  NodeAssert.throws(() => verifyInstalled(target), /changed/);
});
NodeTest.test(
  "disposable user service activates, rolls back and recovers a failed release",
  { skip: !linux || process.env.KO_TEST_SYSTEMD !== "1", timeout: 120_000 },
  async (t) => {
    const root = temp(t),
      unitDirectory = NodePath.join(NodeOS.homedir(), ".config/systemd/user");
    const service = `ko-release-test-${process.pid}.service`;
    const unit = NodePath.join(unitDirectory, service);
    NodeAssert.equal(NodeFS.existsSync(unit), false);
    const socket = NodeNet.createServer();
    socket.listen(0, "127.0.0.1");
    await NodeEvents.once(socket, "listening");
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    const c = {
      root: NodePath.join(root, "deployment"),
      baseDir: NodePath.join(root, "live"),
      node: process.execPath,
      unitDirectory,
      service,
      port,
      baselineVersion: "0.0.40",
    };
    const cfg = NodePath.join(root, "config.json");
    atomicJson(cfg, c);
    NodeAssert.deepEqual(loadConfig(cfg), c);
    const releases = NodePath.join(c.root, "releases");
    const old = installRelease(fixture(root, "old"), releases),
      good = installRelease(fixture(root, "good"), releases),
      bad = installRelease(fixture(root, "bad", true), releases);
    const text = `[Service]\nExecStart=${c.node} ${old}/node_modules/t3/dist/bin.mjs serve --port ${port} --base-dir ${c.baseDir}\nRestart=no\n`;
    NodeFS.mkdirSync(unitDirectory, { recursive: true });
    NodeFS.writeFileSync(unit, text, { flag: "wx" });
    t.after(() => {
      run("systemctl", ["--user", "stop", service]);
      NodeFS.rmSync(unit);
      NodeFS.rmSync(`${unit}.d`, { recursive: true, force: true });
      run("systemctl", ["--user", "daemon-reload"]);
    });
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "start", service]);
    await waitHealthy(c, digest(NodePath.join(old, "node_modules/t3/dist/client/index.html")));
    await manage(c, "activate", NodePath.basename(good));
    NodeAssert.equal(status(c).transaction.phase, "active");
    NodeAssert.equal(NodeFS.realpathSync(NodePath.join(c.root, "current")), good);
    await manage(c, "rollback");
    NodeAssert.equal(status(c).transaction.phase, "rolled-back");
    NodeAssert.equal(NodeFS.existsSync(NodePath.join(c.root, "current")), false);
    NodeAssert.equal(NodeFS.readFileSync(unit, "utf8"), text);
    await NodeAssert.rejects(
      manage(c, "activate", NodePath.basename(bad), {
        healthy: (config, hash) => waitHealthy(config, hash, 5000),
      }),
      /previous service restored/,
    );
    NodeAssert.equal(status(c).transaction.phase, "rolled-back");
    NodeAssert.equal(status(c).state, "active");
    NodeAssert.equal(NodeFS.existsSync(NodePath.join(c.root, "current")), false);
    // Simulate an interrupted transaction; a second activation must not overwrite recovery data.
    const journal = readJson(NodePath.join(c.root, "activation.json"));
    atomicJson(NodePath.join(c.root, "activation.json"), { ...journal, phase: "pending" });
    await NodeAssert.rejects(
      manage(c, "activate", NodePath.basename(good)),
      /Interrupted activation/,
    );
    await manage(c, "rollback");
  },
);
