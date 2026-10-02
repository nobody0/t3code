import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

export const readJson = (path) => JSON.parse(NodeFS.readFileSync(path, "utf8"));
export const digest = (path) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");
export function atomicJson(path, value) {
  const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  NodeFS.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  NodeFS.renameSync(temporary, path);
}
export function run(command, args, options = {}) {
  // Execute npm's JavaScript entry directly: npm.cmd requires a shell and breaks
  // argument boundaries for paths containing spaces on Windows.
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone installer without an Effect runtime.
  if (command === "npm" && process.platform === "win32") {
    const found = NodeChildProcess.spawnSync("where.exe", ["npm.cmd"], { encoding: "utf8" });
    const shim = found.stdout?.trim().split(/\r?\n/)[0];
    const entry = shim && NodePath.join(NodePath.dirname(shim), "node_modules/npm/bin/npm-cli.js");
    if (!entry || !NodeFS.existsSync(entry))
      throw new Error("Cannot locate npm's JavaScript entry.");
    command = process.execPath;
    args = [entry, ...args];
  }
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status}): ${result.stderr ?? ""}`);
  return result.stdout?.trim() ?? "";
}
export function verifyArchive(source) {
  const manifest = readJson(NodePath.join(source, "release.json"));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.repository !== "https://github.com/nobody0/t3code" ||
    typeof manifest.version !== "string" ||
    !/^[0-9][0-9A-Za-z.+-]*$/.test(manifest.version) ||
    !/^[0-9a-f]{40}$/.test(manifest.commit) ||
    typeof manifest.releaseId !== "string" ||
    !/^[0-9][0-9A-Za-z.+-]*-ko-[0-9a-f]{12}(?:-[0-9a-f]{8})?(?:-preview-[0-9]+)?$/.test(
      manifest.releaseId,
    ) ||
    !(
      manifest.releaseId === `${manifest.version}-ko-${manifest.commit.slice(0, 12)}` ||
      manifest.releaseId.startsWith(`${manifest.version}-ko-${manifest.commit.slice(0, 12)}-`)
    ) ||
    manifest.artifact !== "t3-code.tgz" ||
    !/^[0-9a-f]{64}$/.test(manifest.sha256)
  ) {
    throw new Error("Invalid fork release manifest.");
  }
  if (manifest.preview !== false || manifest.dirty !== false)
    throw new Error("Only clean, committed releases can be installed on the fleet.");
  if (digest(NodePath.join(source, manifest.artifact)) !== manifest.sha256)
    throw new Error("Release checksum mismatch.");
  return manifest;
}
function treeDigest(root) {
  const hash = NodeCrypto.createHash("sha256");
  function visit(directory, relative = "") {
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name, "en"),
    )) {
      const name = relative + entry.name;
      const path = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) visit(path, name + "/");
      else if (entry.isFile()) hash.update(name + "\0" + digest(path) + "\0");
      else throw new Error(`Unexpected non-file in packaged runtime: ${path}`);
    }
  }
  visit(root);
  return hash.digest("hex");
}
export function fingerprints(target) {
  return {
    manifest: digest(NodePath.join(target, "release.json")),
    lock: digest(NodePath.join(target, "package-lock.json")),
    package: digest(NodePath.join(target, "node_modules/t3/package.json")),
    dist: treeDigest(NodePath.join(target, "node_modules/t3/dist")),
  };
}
export function verifyInstalled(target) {
  const manifest = verifyArchive(target);
  const receipt = readJson(NodePath.join(target, "installed.json"));
  if (
    receipt.schemaVersion !== 1 ||
    receipt.releaseId !== manifest.releaseId ||
    JSON.stringify(receipt.fingerprints) !== JSON.stringify(fingerprints(target))
  ) {
    throw new Error("Installed release is incomplete or has changed.");
  }
  return manifest;
}
// npm can install node-pty's Darwin spawn-helper without its executable bit.
// Repair only known helper files inside this installed runtime, before testing it.
export function prepareNodePty(target, options = {}) {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone installation on the target platform.
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return [];
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone installation on the target architecture.
  const arch = options.arch ?? process.arch;
  if (!["arm64", "x64"].includes(arch))
    throw new Error("Unsupported Darwin node-pty architecture.");
  const root = NodeFS.realpathSync(target);
  const require = NodeModule.createRequire(NodePath.join(root, "node_modules/t3/package.json"));
  const packageRoot = NodePath.dirname(require.resolve("node-pty/package.json"));
  const inside = (parent, file) => {
    const relative = NodePath.relative(parent, file);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(".." + NodePath.sep) &&
      !NodePath.isAbsolute(relative)
    );
  };
  if (!inside(root, NodeFS.realpathSync(packageRoot)))
    throw new Error("node-pty resolves outside this installed runtime.");
  const helpers = [];
  for (const directory of ["build/Release", "build/Debug", `prebuilds/darwin-${arch}`]) {
    const helper = NodePath.join(packageRoot, directory, "spawn-helper");
    let stat;
    try {
      stat = NodeFS.lstatSync(helper);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile() || !inside(packageRoot, NodeFS.realpathSync(helper)))
      throw new Error("Unsafe Darwin node-pty spawn-helper path.");
    helpers.push(helper);
  }
  if (!helpers.length) throw new Error("Darwin node-pty spawn-helper is missing.");
  for (const helper of helpers) NodeFS.chmodSync(helper, 0o755);
  return helpers;
}
export function installRelease(source, releasesRoot, command = run) {
  const manifest = verifyArchive(source);
  NodeFS.mkdirSync(releasesRoot, { recursive: true });
  const target = NodePath.join(releasesRoot, manifest.releaseId);
  NodeFS.mkdirSync(target);
  for (const name of ["release.json", manifest.artifact])
    NodeFS.copyFileSync(NodePath.join(source, name), NodePath.join(target, name));
  command(
    "npm",
    [
      "install",
      "--prefix",
      target,
      "--no-audit",
      "--no-fund",
      "--save-exact",
      NodePath.join(target, manifest.artifact),
    ],
    { stdio: "inherit", timeout: 600_000 },
  );
  const pkg = readJson(NodePath.join(target, "node_modules/t3/package.json"));
  if (pkg.name !== "t3" || pkg.version !== manifest.version)
    throw new Error("Installed package does not match the release.");
  for (const path of [
    "node_modules/t3/dist/bin.mjs",
    "node_modules/t3/dist/client/index.html",
    "package-lock.json",
  ]) {
    if (!NodeFS.statSync(NodePath.join(target, path)).isFile())
      throw new Error(`Missing runtime file: ${path}`);
  }
  command(process.execPath, [NodePath.join(target, "node_modules/t3/dist/bin.mjs"), "--help"]);
  // CLI help does not exercise the native terminal binding. Test it before sealing.
  if (pkg.dependencies?.["node-pty"]) {
    prepareNodePty(target);
    command(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import {createRequire} from 'node:module';
      const require=createRequire(process.cwd()+'/node_modules/t3/package.json');
      const child=require('node-pty').spawn(process.execPath,['-e','process.stdout.write("ko-runtime-ok")'],{cols:80,rows:24});
      let output='';child.onData(data=>output+=data);
      const timer=setTimeout(()=>{child.kill();process.exit(1)},10000);
      child.onExit(({exitCode})=>{clearTimeout(timer);process.exit(exitCode===0&&output.includes('ko-runtime-ok')?0:1)});
    `,
      ],
      { cwd: target, timeout: 15_000 },
    );
  }
  atomicJson(NodePath.join(target, "installed.json"), {
    schemaVersion: 1,
    releaseId: manifest.releaseId,
    fingerprints: fingerprints(target),
  });
  return target;
}
