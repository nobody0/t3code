import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import { atomicJson, digest, readJson, run, verifyInstalled } from "./ko-release.mjs";
import { nativeManage, nativeStatus, nativeRecovery } from "./ko-deployment-native.mjs";

export function loadConfig(path) {
  const config = readJson(path);
  const platform = config.platform ?? "linux";
  if (!["linux", "darwin", "win32"].includes(platform))
    throw new Error("Unsupported service platform.");
  for (const name of ["root", "baseDir", "node", "unitDirectory"]) {
    if (
      typeof config[name] !== "string" ||
      !NodePath.isAbsolute(config[name]) ||
      /[\r\n\0%]/.test(config[name])
    )
      throw new Error(`Invalid absolute ${name}.`);
    config[name] = NodePath.resolve(config[name]);
  }
  if (
    !(platform === "linux" ? /^[a-zA-Z0-9_-]+\.service$/ : /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).test(
      config.service,
    ) ||
    !Number.isInteger(config.port) ||
    config.port < 1 ||
    config.port > 65535 ||
    typeof config.baselineVersion !== "string"
  )
    throw new Error("Invalid service, port or baselineVersion.");
  if (
    platform === "win32" &&
    (typeof config.userName !== "string" ||
      !/^[a-zA-Z0-9_. -]+\\[a-zA-Z0-9_. -]+$/.test(config.userName))
  )
    throw new Error("Windows requires an explicit DOMAIN\\user operator.");
  const relative = NodePath.relative(config.baseDir, config.root);
  if (
    !relative ||
    (!relative.startsWith(".." + NodePath.sep) &&
      relative !== ".." &&
      !NodePath.isAbsolute(relative))
  )
    throw new Error("Deployment state must be outside the live T3 home.");
  if (!NodeFS.statSync(config.node).isFile())
    throw new Error("Configured Node executable is missing.");
  if (!run(config.node, ["--version"]).startsWith("v24.")) throw new Error("Deploy with Node 24.");
  return config;
}
const overridePath = (c) => NodePath.join(c.unitDirectory, `${c.service}.d`, "90-ko-fork.conf");
const currentPath = (c) => NodePath.join(c.root, "current");
const journalPath = (c) => NodePath.join(c.root, "activation.json");
const control = (c, ...args) => run("systemctl", ["--user", ...args, c.service]);
function optionalText(path) {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function linkTarget(c) {
  try {
    return NodeFS.readlinkSync(currentPath(c));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function setCurrent(c, target) {
  if (target === null) {
    NodeFS.rmSync(currentPath(c), { force: true });
    return;
  }
  const temporary = NodePath.join(c.root, `.current-${NodeCrypto.randomUUID()}`);
  NodeFS.symlinkSync(target, temporary);
  NodeFS.renameSync(temporary, currentPath(c));
}
function writeOverride(c, value) {
  const path = overridePath(c);
  if (value === null) {
    NodeFS.rmSync(path, { force: true });
    return;
  }
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  NodeFS.writeFileSync(temporary, value, { flag: "wx", mode: 0o600 });
  NodeFS.renameSync(temporary, path);
}
async function indexHash(port) {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    signal: AbortSignal.timeout(2000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return NodeCrypto.createHash("sha256")
    .update(Buffer.from(await response.arrayBuffer()))
    .digest("hex");
}
export async function waitHealthy(c, expectedHash, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  let previousPid = "",
    stable = 0,
    lastError;
  while (Date.now() < end) {
    try {
      if (control(c, "is-active") !== "active") throw new Error("Service not active.");
      const pid = control(c, "show", "--property=MainPID", "--value");
      if (!/^[1-9][0-9]*$/.test(pid)) throw new Error("No service process.");
      if ((await indexHash(c.port)) !== expectedHash)
        throw new Error("Served client does not match release.");
      stable = previousPid === pid ? stable + 1 : 1;
      previousPid = pid;
      if (stable >= 3) return;
    } catch (error) {
      stable = 0;
      lastError = error;
    }
    await NodeTimersPromises.setTimeout(1000);
  }
  throw new Error(`Service failed validation: ${lastError?.message ?? "unstable PID"}`);
}
export async function smoke(c, target) {
  const smokeEnvironment = { ...process.env, T3_KO_MANAGED: "1" };
  delete smokeEnvironment.T3_BOOT_SERVICE_UNIT;
  delete smokeEnvironment.T3_SERVICE_LAUNCHER_CONTEXT;
  const directory = NodeFS.mkdtempSync(NodePath.join(c.root, "smoke-"));
  NodeFS.chmodSync(directory, 0o700);
  const log = NodeFS.openSync(NodePath.join(directory, "startup.log"), "wx", 0o600);
  const socket = NodeNet.createServer();
  let child;
  try {
    socket.listen(0, "127.0.0.1");
    await NodeEvents.once(socket, "listening");
    const port = socket.address().port;
    await new Promise((resolve, reject) =>
      socket.close((error) => (error ? reject(error) : resolve())),
    );
    child = NodeChildProcess.spawn(
      c.node,
      [
        NodePath.join(target, "node_modules/t3/dist/bin.mjs"),
        "serve",
        "--base-dir",
        directory,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      {
        cwd: directory,
        env: { ...smokeEnvironment, T3CODE_HOME: directory },
        stdio: ["ignore", log, log],
        windowsHide: true,
      },
    );
    let spawnError;
    child.on("error", (error) => {
      spawnError = error;
    });
    const expected = digest(NodePath.join(target, "node_modules/t3/dist/client/index.html"));
    const end = Date.now() + 60_000;
    let stable = 0;
    while (Date.now() < end) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error("Isolated server exited during startup.");
      try {
        stable = (await indexHash(port)) === expected ? stable + 1 : 0;
      } catch {
        stable = 0;
      }
      if (stable >= 3) return;
      await NodeTimersPromises.setTimeout(1000);
    }
    throw new Error("Isolated server failed startup validation.");
  } finally {
    if (socket.listening) socket.close();
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      const stopped = await Promise.race([
        exited.then(() => true),
        NodeTimersPromises.setTimeout(5000).then(() => false),
      ]);
      if (!stopped) {
        child.kill("SIGKILL");
        await exited;
      }
    }
    NodeFS.closeSync(log);
    // Only the mkdtemp directory created by this invocation is removed.
    NodeFS.rmSync(directory, { recursive: true });
  }
}
function restore(c, previous) {
  setCurrent(c, previous.link);
  writeOverride(c, previous.override);
  run("systemctl", ["--user", "daemon-reload"]);
  control(c, "restart");
}
export function readRecovery(c) {
  if (c.platform && c.platform !== "linux") return nativeRecovery(c);
  if (!NodeFS.existsSync(journalPath(c))) return { transaction: null, configMismatch: [] };
  const transaction = readJson(journalPath(c));
  const configMismatch = ["root", "unitDirectory", "baseDir"].filter(
    (name) =>
      typeof transaction.config?.[name] !== "string" ||
      NodePath.resolve(transaction.config[name]) !== NodePath.resolve(c[name]),
  );
  for (const name of ["service", "port"]) {
    if (transaction.config?.[name] !== c[name]) configMismatch.push(name);
  }
  return { transaction, configMismatch };
}
export function status(c) {
  if (c.platform && c.platform !== "linux") return nativeStatus(c);
  return {
    service: c.service,
    state: control(c, "show", "--property=ActiveState", "--value"),
    current: linkTarget(c),
    ...readRecovery(c),
  };
}
export async function manage(c, operation, releaseId, dependencies = {}) {
  if (c.platform && c.platform !== "linux")
    return nativeManage(c, operation, releaseId, { smoke, ...dependencies });
  const trial = dependencies.smoke ?? smoke;
  const healthy = dependencies.healthy ?? waitHealthy;
  const recover = dependencies.restore ?? restore;
  NodeFS.mkdirSync(c.root, { recursive: true });
  const lock = NodePath.join(c.root, "activation.lock");
  const fd = NodeFS.openSync(lock, "wx", 0o600);
  NodeFS.writeFileSync(fd, String(process.pid));
  try {
    const { transaction, configMismatch } = readRecovery(c);
    if (configMismatch.length)
      throw new Error(
        `Deployment identity changed (${configMismatch.join(", ")}); use the recorded configuration for recovery.`,
      );
    if (operation === "rollback") {
      if (!transaction) throw new Error("No deployment to roll back.");
      const journal = transaction;
      if (journal.phase === "rolled-back") throw new Error("Already rolled back.");
      atomicJson(journalPath(c), { ...journal, phase: "pending" });
      await recover(c, journal.previous);
      await healthy(c, journal.previous.indexHash);
      atomicJson(journalPath(c), { ...journal, phase: "rolled-back" });
      return;
    }
    if (operation !== "activate") throw new Error("Unknown operation.");
    if (transaction?.phase === "pending")
      throw new Error("Interrupted activation or rollback: run rollback first.");
    if (typeof releaseId !== "string" || !/^[0-9][0-9A-Za-z.+-]*$/.test(releaseId))
      throw new Error("Invalid release ID.");
    const target = NodePath.join(c.root, "releases", releaseId);
    const manifest = verifyInstalled(target);
    if (manifest.releaseId !== releaseId)
      throw new Error("Release directory does not match manifest.");
    if (manifest.version !== c.baselineVersion)
      throw new Error(
        "Upstream version changed: review migrations and recovery before changing baselineVersion.",
      );
    if (linkTarget(c) === target) throw new Error("Release already selected.");
    await trial(c, target);
    const previous = {
      link: linkTarget(c),
      override: optionalText(overridePath(c)),
      indexHash: await indexHash(c.port),
    };
    if (control(c, "is-active") !== "active") throw new Error("Existing service is not active.");
    const journal = { schemaVersion: 1, config: c, phase: "pending", releaseId, previous };
    atomicJson(journalPath(c), journal);
    try {
      setCurrent(c, target);
      const quote = (value) => '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
      writeOverride(
        c,
        `[Service]\nUnsetEnvironment=T3_BOOT_SERVICE_UNIT T3_SERVICE_LAUNCHER_CONTEXT\nEnvironment=T3_KO_MANAGED=1\nExecStart=\nExecStart=${[c.node, NodePath.join(currentPath(c), "node_modules/t3/dist/bin.mjs"), "serve", "--host", "127.0.0.1", "--port", String(c.port), "--base-dir", c.baseDir].map(quote).join(" ")}\n`,
      );
      run("systemctl", ["--user", "daemon-reload"]);
      control(c, "restart");
      await healthy(c, digest(NodePath.join(target, "node_modules/t3/dist/client/index.html")));
      atomicJson(journalPath(c), { ...journal, phase: "active" });
    } catch (error) {
      try {
        await recover(c, previous);
        await healthy(c, previous.indexHash);
        atomicJson(journalPath(c), { ...journal, phase: "rolled-back", failure: error.message });
      } catch (recovery) {
        throw new AggregateError(
          [error, recovery],
          "Activation and rollback failed; transaction retained for manual recovery.",
          { cause: recovery },
        );
      }
      throw new Error(`Activation failed; previous service restored: ${error.message}`, {
        cause: error,
      });
    }
  } finally {
    NodeFS.closeSync(fd);
    NodeFS.unlinkSync(lock);
  }
}
