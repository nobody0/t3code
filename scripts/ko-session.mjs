#!/usr/bin/env node
// Standalone operational client; intentionally has no workspace dependencies.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
const id = (kind, key) => `ko-${kind}-${hash(key).slice(0, 32)}`;
const required = (value, name) => {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must be a nonempty string.`);
  return value;
};

export const help = `KO task launcher for an installed T3 server (Node >=22 or Bun).

  node ko-session.mjs check|start --home-dir PATH --origin URL
    --environment-id ID --t3-command '["/path/to/t3"]' [--request FILE|-]
    [--watch-origin URL] [--wait-ms 15000]

Run on the target device, locally or over SSH. --home-dir is the existing T3
base directory, not userdata. --t3-command is a JSON argv array, e.g.
["node","/opt/t3/dist/index.mjs"]. It must be the installed release's CLI.
The helper calls its auth CLI with --base-dir; no shell command is evaluated.
check probes the runtime, descriptor, authenticated API and provider configuration.
It creates a short-lived session and revokes it; it never starts an agent.

start requires JSON from --request (use '-' for stdin):
{"requestId":"unique-attempt-id","cwd":"/verified/checkout","ref":"main",
 "title":"KO task title","prompt":"Self-contained task and related context",
 "modelSelection":{"instanceId":"codex","model":"chosen-model"}}

modelSelection defaults to the existing project's saved model; missing selection
fails before dispatch and lists available providers/models. Optional workspace is
"worktree" (default) or "local". Worktrees start from the verified ref's current
local commit, without pulling. Dirty changes are not copied into isolated worktrees.
runtimeMode defaults to "approval-required"; interactionMode defaults to "default".
Optional projectTitle names a newly registered project. Setup scripts do not run.

Reuse the SAME requestId and unchanged request after timeout or uncertain results.
Receipts in <home>/ko-launches preserve exact command IDs/payloads; do not delete
them during retries. A new ID intentionally starts new work. Output is safe JSON:
started, completed, interrupted, failed, or accepted (not yet confirmed running).
Errors after possible dispatch include the request/thread IDs for recovery.
--watch-origin may point to the shared Caps UI; it must already know this environment.
Neither a healthy descriptor nor accepted dispatch alone proves an agent is running.
`;

export function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const [action, ...rest] = argv;
  if (!["check", "start"].includes(action)) throw new Error("Choose check or start; see --help.");
  const options = { action, waitMs: 15000 };
  const names = {
    "--home-dir": "homeDir",
    "--origin": "origin",
    "--environment-id": "environmentId",
    "--t3-command": "t3Command",
    "--request": "request",
    "--watch-origin": "watchOrigin",
    "--wait-ms": "waitMs",
  };
  for (let i = 0; i < rest.length; i += 2) {
    const key = names[rest[i]];
    if (!key || rest[i + 1] === undefined)
      throw new Error(`Invalid option ${rest[i]}; see --help.`);
    options[key] = rest[i + 1];
  }
  for (const key of ["homeDir", "origin", "environmentId", "t3Command"])
    required(options[key], key);
  options.t3Command = JSON.parse(options.t3Command);
  if (
    !Array.isArray(options.t3Command) ||
    !options.t3Command.length ||
    options.t3Command.some((v) => typeof v !== "string" || !v)
  ) {
    throw new Error("--t3-command must be a nonempty JSON argv array.");
  }
  options.waitMs = Number(options.waitMs);
  if (!Number.isFinite(options.waitMs) || options.waitMs < 0 || options.waitMs > 60000)
    throw new Error("--wait-ms must be 0..60000.");
  if (action === "start") required(options.request, "--request");
  return options;
}

function origin(value) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("Use an HTTP(S) origin without credentials, path, query or fragment.");
  }
  return url.origin;
}

// Current Effect RPC JSON framing, limited to one non-streaming RPC per connection.
export async function callRpc(
  http,
  base,
  tag,
  payload,
  { WebSocketClass = globalThis.WebSocket, timeoutMs = 10000 } = {},
) {
  if (!WebSocketClass) throw new Error("Native WebSocket is required; use Node >=22 or Bun.");
  const { ticket } = await http("/api/auth/websocket-ticket", { method: "POST" });
  const url = new URL("/ws", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("wsTicket", ticket);
  return new Promise((resolveConfig, reject) => {
    let socket;
    let settled = false;
    const finish = (error, config) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.close();
      if (error) reject(error);
      else resolveConfig(config);
    };
    const timer = setTimeout(
      () => finish(new Error(`T3 ${tag} timed out; preserve the requestId when retrying.`)),
      timeoutMs,
    );
    try {
      socket = new WebSocketClass(url);
    } catch {
      finish(new Error("Could not open T3 WebSocket."));
      return;
    }
    socket.addEventListener("open", () =>
      socket.send(JSON.stringify({ _tag: "Request", id: "ko-rpc", tag, payload, headers: [] })),
    );
    socket.addEventListener("error", () => finish(new Error("T3 WebSocket failed.")));
    socket.addEventListener("close", () =>
      finish(new Error("T3 WebSocket closed before its response.")),
    );
    socket.addEventListener("message", (event) => {
      try {
        const parsed = JSON.parse(String(event.data));
        for (const frame of Array.isArray(parsed) ? parsed : [parsed]) {
          if (frame._tag === "Exit" && frame.requestId === "ko-rpc") {
            if (frame.exit?._tag === "Success") finish(null, frame.exit.value);
            else finish(new Error(`T3 rejected ${tag}; check auth scopes and server logs.`));
          } else if (["Defect", "ClientProtocolError"].includes(frame._tag)) {
            finish(new Error("T3 RPC protocol failed; check helper/server version compatibility."));
          }
        }
      } catch {
        finish(new Error("Invalid T3 RPC response; check helper/server version compatibility."));
      }
    });
  });
}

export function readServerConfig(http, base, WebSocketClass = globalThis.WebSocket) {
  return callRpc(http, base, "server.getConfig", {}, { WebSocketClass });
}

export function providerSummary(config) {
  return (config.providers ?? []).map((p) => ({
    instanceId: p.instanceId,
    driver: p.driver,
    ready:
      p.enabled &&
      p.installed &&
      ["ready", "warning"].includes(p.status) &&
      p.auth?.status !== "unauthenticated" &&
      p.availability !== "unavailable",
    status: p.status,
    auth: p.auth?.status,
    models: (p.models ?? []).map((m) => m.slug),
  }));
}

function savedProjectModel(config, project) {
  if (!project) return null;
  const settings = config.settings;
  const overrides = settings?.projectSettingsOverrides?.[project.id];
  if (overrides && Object.hasOwn(overrides, "defaultModelSelection"))
    return overrides.defaultModelSelection;
  // After the one-time fold, aggregate fields can be stale: a reset removes the
  // canonical override and must not resurrect the old saved project selection.
  if (settings?.projectSettingsFolded) return null;
  return project.defaultModelSelection ?? null;
}

function normalizeRequest(input) {
  for (const key of ["requestId", "cwd", "ref", "title", "prompt"]) required(input[key], key);
  if (!["worktree", "local"].includes(input.workspace ?? "worktree"))
    throw new Error("workspace must be worktree or local.");
  if (
    !["approval-required", "auto-accept-edits", "auto", "full-access"].includes(
      input.runtimeMode ?? "approval-required",
    )
  )
    throw new Error("Invalid runtimeMode.");
  if (!["default", "plan"].includes(input.interactionMode ?? "default"))
    throw new Error("Invalid interactionMode.");
  if (input.modelSelection) {
    required(input.modelSelection.instanceId, "modelSelection.instanceId");
    required(input.modelSelection.model, "modelSelection.model");
  }
  return {
    ...input,
    workspace: input.workspace ?? "worktree",
    runtimeMode: input.runtimeMode ?? "approval-required",
    interactionMode: input.interactionMode ?? "default",
  };
}

export function executionStatus(thread) {
  if (!thread) return "accepted";
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") return "failed";
  if (thread.latestTurn?.state === "completed") return "completed";
  if (thread.latestTurn?.state === "interrupted") return "interrupted";
  if (thread.session?.status === "running" && thread.session?.activeTurnId) return "started";
  return "accepted";
}

export async function run(options, input, dependencies = {}) {
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const execute = dependencies.exec ?? exec;
  const getConfig = dependencies.getConfig ?? readServerConfig;
  const alive =
    dependencies.alive ??
    ((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  const pause = dependencies.pause ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const base = origin(options.origin);
  const watch = origin(options.watchOrigin ?? base);
  const homeDir = await realpath(options.homeDir);
  let bearer;
  let sessionId;
  let output;
  let receipt;
  let cleanupWarning;
  const http = async (path, init = {}, allowMissing = false) => {
    let response;
    try {
      response = await fetcher(new URL(path, base), {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: {
          "Content-Type": "application/json",
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          ...init.headers,
        },
      });
    } catch {
      throw new Error(
        `T3 ${path.split("?")[0]} transport failed; keep the same requestId when retrying.`,
      );
    }
    if (allowMissing && response.status === 404) return null;
    if (!response.ok)
      throw new Error(
        `T3 ${path.split("?")[0]} returned HTTP ${response.status}; inspect server logs.`,
      );
    try {
      return await response.json();
    } catch {
      throw new Error(`T3 ${path} returned invalid JSON.`);
    }
  };
  const auth = async (args) => {
    const [command, ...prefix] = options.t3Command;
    try {
      return await execute(
        command,
        [...prefix, "auth", "session", ...args, "--base-dir", homeDir],
        { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true },
      );
    } catch {
      throw new Error("T3 auth CLI failed; check the installed CLI and explicit home directory.");
    }
  };
  try {
    // Do not trust a stale state file or an unrelated listener on a reused port.
    const runtime = JSON.parse(
      await readFile(join(homeDir, "userdata", "server-runtime.json"), "utf8"),
    );
    if (!Number.isInteger(runtime.pid) || runtime.pid <= 0 || !alive(runtime.pid))
      throw new Error("T3 runtime PID is not alive; recover its documented service first.");
    if (origin(runtime.origin) !== base)
      throw new Error(
        "Explicit origin differs from this home's runtime origin; use its verified local origin.",
      );
    const descriptor = await http("/.well-known/t3/environment");
    if (descriptor.environmentId !== options.environmentId)
      throw new Error("T3 environment identity mismatch; check the target device and deployment.");
    let issued;
    try {
      issued = JSON.parse(
        (await auth(["issue", "--ttl", "5m", "--label", "ko-session", "--json"])).stdout,
      );
    } catch {
      throw new Error(
        "T3 auth CLI did not return a valid session; inspect the installed CLI version.",
      );
    }
    sessionId = required(issued.sessionId, "issued sessionId");
    bearer = required(issued.token, "issued token");
    const shell = await http("/api/orchestration/shell");
    if (!Array.isArray(shell.projects)) throw new Error("Unsupported T3 shell response.");
    if (options.action === "check") {
      const providers = providerSummary(await getConfig(http, base));
      output = {
        status: "healthy",
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        serverVersion: descriptor.serverVersion,
        providers,
      };
    } else {
      const request = normalizeRequest(input);
      const requestHash = hash(
        canonical({ environmentId: options.environmentId, origin: base, request }),
      );
      const receiptsDir = join(homeDir, "ko-launches");
      const receiptPath = join(receiptsDir, `${hash(request.requestId)}.json`);
      try {
        receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if (receipt && receipt.requestHash !== requestHash)
        throw new Error(
          "requestId already belongs to different input; reuse its original request or intentionally choose a new ID.",
        );
      const report = async (thread, sequence) => ({
        requestId: request.requestId,
        environmentId: options.environmentId,
        projectId: receipt.projectId,
        threadId: receipt.command.threadId,
        status: executionStatus(thread),
        sequence,
        cwd: thread?.worktreePath ?? receipt.cwd,
        ref: thread?.branch ?? receipt.ref,
        url: `${watch}/${encodeURIComponent(options.environmentId)}/${encodeURIComponent(receipt.command.threadId)}`,
        ...(thread?.session?.lastError ? { error: thread.session.lastError } : {}),
      });
      let thread = receipt
        ? (await http(`/api/orchestration/threads/${receipt.command.threadId}`, {}, true))?.thread
        : null;
      const messageAlreadyStored = thread?.messages?.some(
        (m) => m.id === receipt.command.message.messageId,
      );
      if (messageAlreadyStored) {
        output = await report(thread);
      } else {
        if (!receipt) {
          const cwd = await realpath(request.cwd);
          const git = async (...args) =>
            (
              await execute("git", ["-C", cwd, ...args], { timeout: 10000, windowsHide: true })
            ).stdout.trim();
          const currentCommit = await git("rev-parse", "HEAD");
          const intendedCommit = await git("rev-parse", "--verify", `${request.ref}^{commit}`);
          if (currentCommit !== intendedCommit)
            throw new Error(
              "Checkout HEAD differs from the requested ref; verify KO worktree documentation before launching.",
            );
          const matches = [];
          for (const project of shell.projects.filter((p) => !p.deletedAt)) {
            try {
              if ((await realpath(project.workspaceRoot)) === cwd) matches.push(project);
            } catch {
              /* Historical project path. */
            }
          }
          if (matches.length > 1)
            throw new Error(
              "Multiple T3 projects use this checkout; resolve the duplicate project records before launch.",
            );
          const project = matches[0];
          const config = await getConfig(http, base);
          const modelSelection = request.modelSelection ?? savedProjectModel(config, project);
          const providers = providerSummary(config);
          if (!modelSelection)
            throw new Error(
              `Choose modelSelection or save a project default first. Available providers/models: ${JSON.stringify(providers)}`,
            );
          const provider = providers.find(
            (p) => p.instanceId === (modelSelection.instanceId ?? modelSelection.provider),
          );
          if (!provider?.ready)
            throw new Error(
              `Selected provider is not ready. Provider status: ${JSON.stringify(providers)}`,
            );
          if (!provider.models.includes(modelSelection.model))
            throw new Error(
              `Selected model is not in the provider catalog. Available models: ${provider.models.join(", ")}`,
            );
          const key = `${options.environmentId}:${request.requestId}`;
          const projectKey = `${options.environmentId}:${process.platform === "win32" ? cwd.toLowerCase() : cwd}`;
          const projectId = project?.id ?? id("project", projectKey);
          const createdAt = new Date().toISOString();
          const threadId = id("thread", key);
          const branch =
            request.workspace === "worktree" ? `ko/${hash(key).slice(0, 16)}` : request.ref;
          const selection = {
            ...modelSelection,
            instanceId: modelSelection.instanceId ?? modelSelection.provider,
          };
          delete selection.provider;
          receipt = {
            version: 1,
            requestHash,
            cwd,
            ref: request.ref,
            headCommit: currentCommit,
            workspace: request.workspace,
            projectId,
            projectCommand: project
              ? null
              : {
                  type: "project.create",
                  commandId: id("project-command", projectKey),
                  projectId,
                  title: request.projectTitle ?? request.title,
                  workspaceRoot: cwd,
                  createdAt,
                },
            command: {
              type: "thread.turn.start",
              commandId: id("turn-command", key),
              threadId,
              message: {
                messageId: id("message", key),
                role: "user",
                text: request.prompt,
                attachments: [],
              },
              modelSelection: selection,
              runtimeMode: request.runtimeMode,
              interactionMode: request.interactionMode,
              createdAt,
              bootstrap: {
                createThread: {
                  projectId,
                  title: request.title,
                  modelSelection: selection,
                  runtimeMode: request.runtimeMode,
                  interactionMode: request.interactionMode,
                  branch: request.workspace === "local" ? request.ref : null,
                  worktreePath: null,
                  createdAt,
                },
                runSetupScript: false,
                ...(request.workspace === "worktree"
                  ? {
                      prepareWorktree: {
                        projectCwd: cwd,
                        baseBranch: currentCommit,
                        branch,
                        startFromOrigin: false,
                      },
                    }
                  : {}),
              },
            },
          };
          await mkdir(receiptsDir, { recursive: true, mode: 0o700 });
          try {
            await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", {
              flag: "wx",
              mode: 0o600,
            });
          } catch (e) {
            if (e.code !== "EEXIST") throw e;
            receipt = JSON.parse(await readFile(receiptPath, "utf8"));
            if (receipt.requestHash !== requestHash)
              throw new Error("Concurrent requestId collision.");
          }
        }
        if (receipt.workspace === "local") {
          const currentCommit = (
            await execute("git", ["-C", receipt.cwd, "rev-parse", "HEAD"], {
              timeout: 10000,
              windowsHide: true,
            })
          ).stdout.trim();
          if (currentCommit !== receipt.headCommit)
            throw new Error(
              "Local checkout moved since this request was prepared; inspect it before intentionally creating another request.",
            );
        }
        if (receipt.projectCommand)
          await http("/api/orchestration/dispatch", {
            method: "POST",
            body: JSON.stringify(receipt.projectCommand),
          });
        // HTTP dispatch bypasses the UI's bootstrap handler. Thread/worktree bootstrap
        // must use this normal WebSocket RPC, the same path as the T3 composer.
        const dispatchTurn =
          dependencies.dispatchTurn ??
          ((command) =>
            callRpc(http, base, "orchestration.dispatchCommand", command, { timeoutMs: 55000 }));
        const { sequence } = await dispatchTurn(receipt.command);
        const deadline = Date.now() + (options.waitMs ?? 15000);
        do {
          thread = (await http(`/api/orchestration/threads/${receipt.command.threadId}`, {}, true))
            ?.thread;
          if (executionStatus(thread) !== "accepted" || Date.now() >= deadline) break;
          await pause(500);
        } while (true);
        output = await report(thread, sequence);
      }
    }
  } catch (e) {
    // Never propagate CLI stdout/stderr or the WebSocket URL (both may contain credentials).
    const message = e instanceof Error ? e.message : "Unknown helper error.";
    const safeMessage = bearer ? message.split(bearer).join("[redacted]") : message;
    output = {
      status: "error",
      error: safeMessage,
      ...(input?.requestId
        ? {
            requestId: input.requestId,
            retry:
              "Reuse this requestId and identical request; do not start a new attempt after an uncertain result.",
          }
        : {}),
      ...(receipt?.command?.threadId ? { threadId: receipt.command.threadId } : {}),
    };
  } finally {
    if (sessionId) {
      try {
        await auth(["revoke", sessionId]);
      } catch {
        cleanupWarning = "Temporary session revocation failed; it expires within five minutes.";
      }
    }
    if (bearer && output)
      output = JSON.parse(JSON.stringify(output).split(bearer).join("[redacted]"));
    bearer = undefined;
  }
  return cleanupWarning ? { ...output, warnings: [cleanupWarning] } : output;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(help);
      return;
    }
    let input;
    if (options.action === "start") {
      const text =
        options.request === "-"
          ? await new Promise((res, rej) => {
              let content = "";
              process.stdin.setEncoding("utf8");
              process.stdin.on("data", (chunk) => {
                content += chunk;
              });
              process.stdin.on("end", () => res(content));
              process.stdin.on("error", rej);
            })
          : await readFile(options.request, "utf8");
      input = JSON.parse(text);
    }
    const result = await run(options, input);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (["error", "failed"].includes(result.status)) process.exitCode = 1;
  } catch {
    process.stderr.write("Invalid invocation or unreadable request; use --help.\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
