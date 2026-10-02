import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { prepareNodePty } from "./lib/ko-release.mjs";

function fixture(t, nested) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ko-node-pty-test-"));
  t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  const target = NodePath.join(root, "runtime");
  const t3 = NodePath.join(target, "node_modules/t3");
  NodeFS.mkdirSync(t3, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(t3, "package.json"), '{"name":"t3"}');
  const pty = NodePath.join(nested ? t3 : target, "node_modules/node-pty");
  NodeFS.mkdirSync(pty, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(pty, "package.json"), '{"name":"node-pty"}');
  return { root, target, pty };
}
function file(root, relative) {
  const result = NodePath.join(root, relative);
  NodeFS.mkdirSync(NodePath.dirname(result), { recursive: true });
  NodeFS.writeFileSync(result, "fixture", { mode: 0o644 });
  NodeFS.chmodSync(result, 0o644);
  return result;
}
for (const nested of [false, true])
  NodeTest.test(
    `repairs Darwin helper in ${nested ? "nested" : "hoisted"} dependency without changing other platforms`,
    (t) => {
      const { target, pty } = fixture(t, nested);
      const helper = file(pty, "prebuilds/darwin-arm64/spawn-helper");
      const untouched = [
        file(pty, "prebuilds/linux-arm64/spawn-helper"),
        file(pty, "prebuilds/darwin-x64/spawn-helper"),
        file(pty, "prebuilds/darwin-arm64/pty.node"),
      ];
      NodeAssert.deepEqual(prepareNodePty(target, { platform: "linux", arch: "arm64" }), []);
      NodeAssert.deepEqual(prepareNodePty(target, { platform: "darwin", arch: "arm64" }), [
        NodeFS.realpathSync(helper),
      ]);
      // Windows does not represent Unix executable bits. POSIX fixture runs assert them.
      // oxlint-disable-next-line t3code/no-global-process-runtime -- Platform filesystem behavior in a standalone test.
      if (process.platform !== "win32") {
        NodeAssert.equal(NodeFS.statSync(helper).mode & 0o777, 0o755);
        for (const other of untouched) NodeAssert.equal(NodeFS.statSync(other).mode & 0o777, 0o644);
      }
    },
  );
NodeTest.test("rejects an escaped helper directory before changing file permissions", (t) => {
  const { root, target, pty } = fixture(t, true);
  const outside = NodePath.join(root, "outside");
  const escaped = file(outside, "spawn-helper");
  NodeFS.mkdirSync(NodePath.join(pty, "prebuilds"));
  NodeFS.symlinkSync(outside, NodePath.join(pty, "prebuilds/darwin-arm64"), "junction");
  NodeAssert.throws(
    () => prepareNodePty(target, { platform: "darwin", arch: "arm64" }),
    /Unsafe Darwin/,
  );
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Platform filesystem behavior in a standalone test.
  if (process.platform !== "win32") NodeAssert.equal(NodeFS.statSync(escaped).mode & 0o777, 0o644);
});
NodeTest.test(
  "missing Darwin helper fails explicitly; other platforms do not resolve node-pty",
  (t) => {
    const { target } = fixture(t, false);
    NodeAssert.throws(
      () => prepareNodePty(target, { platform: "darwin", arch: "arm64" }),
      /helper is missing/,
    );
    NodeAssert.deepEqual(prepareNodePty("/does-not-exist", { platform: "win32" }), []);
  },
);
