import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import { atomicJson, digest, readJson, verifyInstalled } from "./ko-release.mjs";
import { platformAdapter, optionalFile } from "./ko-service-platforms.mjs";

const journalPath = (c) => NodePath.join(c.root, "activation.json");
const selectionPath = (c) => NodePath.join(c.root, "current.json");
function selected(c) {
  const contents = optionalFile(selectionPath(c));
  return contents === null ? null : JSON.parse(contents).target;
}
function select(c, target) {
  if (target === null) NodeFS.rmSync(selectionPath(c), { force: true });
  else atomicJson(selectionPath(c), { target });
}
export function nativeRecovery(c) {
  if (!NodeFS.existsSync(journalPath(c))) return { transaction: null, configMismatch: [] };
  const transaction = readJson(journalPath(c));
  const configMismatch = ["root", "unitDirectory", "baseDir"].filter(
    (name) =>
      typeof transaction.config?.[name] !== "string" ||
      NodePath.resolve(transaction.config[name]) !== NodePath.resolve(c[name]),
  );
  for (const name of ["platform", "service", "port", "userName"])
    if (transaction.config?.[name] !== c[name]) configMismatch.push(name);
  return { transaction, configMismatch };
}
export function nativeStatus(c) {
  return {
    service: c.service,
    ...platformAdapter(c).info(),
    current: selected(c),
    ...nativeRecovery(c),
  };
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
async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", () =>
      reject(
        new Error(
          `Port ${port} is occupied; stop the identified old T3 service before first installation.`,
        ),
      ),
    );
    server.listen(port, "127.0.0.1", () =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
}
async function healthy(c, expectedHash, adapter) {
  if (expectedHash === null) {
    if (adapter.info().state === "active")
      throw new Error("New service remains active after failed first installation.");
    await assertPortFree(c.port);
    return;
  }
  const deadline = Date.now() + 60_000;
  let lastPid = "",
    stable = 0,
    lastError;
  while (Date.now() < deadline) {
    try {
      const info = adapter.info();
      if (info.state !== "active" || !/^[1-9][0-9]*$/.test(info.pid))
        throw new Error("Service has no active process.");
      if ((await indexHash(c.port)) !== expectedHash)
        throw new Error("Served client differs from release.");
      stable = info.pid === lastPid ? stable + 1 : 1;
      lastPid = info.pid;
      if (stable >= 3) return;
    } catch (error) {
      stable = 0;
      lastError = error;
    }
    await NodeTimersPromises.setTimeout(1000);
  }
  throw new Error(`Service validation failed: ${lastError?.message ?? "unstable process"}`);
}
export async function nativeManage(c, operation, releaseId, dependencies = {}) {
  const adapter = dependencies.adapter ?? platformAdapter(c);
  const verify = dependencies.verify ?? verifyInstalled;
  const trial = dependencies.smoke;
  const health = dependencies.healthy ?? ((config, hash) => healthy(config, hash, adapter));
  const getHash = dependencies.indexHash ?? indexHash;
  const portFree = dependencies.portFree ?? assertPortFree;
  const recover = async (previous) => {
    adapter.restore(previous.service);
    select(c, previous.target);
    await health(c, previous.indexHash);
  };
  NodeFS.mkdirSync(c.root, { recursive: true });
  const lock = NodePath.join(c.root, "activation.lock");
  const fd = NodeFS.openSync(lock, "wx", 0o600);
  NodeFS.writeFileSync(fd, String(process.pid));
  try {
    const { transaction, configMismatch } = nativeRecovery(c);
    if (configMismatch.length)
      throw new Error(
        `Deployment identity changed (${configMismatch.join(", ")}); use the recorded configuration for recovery.`,
      );
    if (operation === "rollback") {
      if (!transaction) throw new Error("No deployment to roll back.");
      if (transaction.phase === "rolled-back") throw new Error("Already rolled back.");
      atomicJson(journalPath(c), { ...transaction, phase: "pending" });
      await recover(transaction.previous);
      atomicJson(journalPath(c), { ...transaction, phase: "rolled-back" });
      return;
    }
    if (operation !== "activate") throw new Error("Unknown operation.");
    if (transaction?.phase === "pending")
      throw new Error("Interrupted activation or rollback: run rollback first.");
    if (typeof releaseId !== "string" || !/^[0-9][0-9A-Za-z.+-]*$/.test(releaseId))
      throw new Error("Invalid release ID.");
    const target = NodePath.join(c.root, "releases", releaseId);
    const manifest = verify(target);
    if (manifest.releaseId !== releaseId)
      throw new Error("Release directory does not match manifest.");
    if (manifest.version !== c.baselineVersion)
      throw new Error(
        "Upstream version changed: review migrations and recovery before changing baselineVersion.",
      );
    if (selected(c) === target) throw new Error("Release already selected.");
    if (typeof trial !== "function") throw new Error("Isolated startup validation is required.");
    await trial(c, target);
    const service = adapter.capture();
    const exists = service.definition !== null;
    if (exists && adapter.info().state !== "active")
      throw new Error("Existing service is not active; diagnose it before activation.");
    if (!exists) await portFree(c.port);
    const previous = {
      service,
      target: selected(c),
      indexHash: exists ? await getHash(c.port) : null,
    };
    const journal = { schemaVersion: 2, config: c, phase: "pending", releaseId, previous };
    atomicJson(journalPath(c), journal);
    try {
      NodeFS.mkdirSync(c.baseDir, { recursive: true });
      adapter.install(target);
      select(c, target);
      await health(c, digest(NodePath.join(target, "node_modules/t3/dist/client/index.html")));
      atomicJson(journalPath(c), { ...journal, phase: "active" });
    } catch (error) {
      try {
        await recover(previous);
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
