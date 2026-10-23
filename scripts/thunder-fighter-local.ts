import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { startDaemon } from "../src/desktop/daemon-process.js";
import type { CanvasWorkspaceDetail } from "../src/shared/canvas-workspace.js";
import type { ExternalMcpEndpoint } from "../src/shared/external-mcp.js";
import type { ProjectState } from "../src/shared/contracts.js";

type AssetKey = "player" | "enemy" | "boss";

interface GeneratedShip {
  glbPath: string;
  sha256: string;
  bytes: number;
  triangles: number;
  gatesOk: boolean;
}

interface GeneratedShips {
  manifestPath: string;
  assets: Record<AssetKey, GeneratedShip>;
}

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const gameFactoryRoot = path.resolve(
  process.env.GAMEFACTORY_ROOT ??
    path.join(repositoryRoot, "..", "GameFactory-3A"),
);
const gameFactoryPython = process.env.GAMEFACTORY_PYTHON ?? "python3";
const dataDirectory = path.resolve(
  process.env.OHMYGAME_THUNDER_DATA ??
    path.join(tmpdir(), "ohmygame-thunder-fighter"),
);
const appToken = "thunder-fighter-local-poc";
const gameSource = path.join(repositoryRoot, "scripts", "thunder-fighter");

await mkdir(dataDirectory, { recursive: true });
const root = await mkdtemp(path.join(dataDirectory, "run-"));
const preinstalled = path.join(root, "preinstalled");
await mkdir(preinstalled, { recursive: true });
await writeFile(
  path.join(preinstalled, "index.json"),
  '{"version":1,"plugins":[]}\n',
  "utf8",
);

const daemon = await startDaemon({
  daemonEntry: path.join(repositoryRoot, "dist", "daemon", "server.js"),
  dataDirectory: root,
  piAgentDirectory: path.join(root, "pi-agent"),
  token: appToken,
  allowedOrigins: [],
  preinstalledPluginsDirectory: preinstalled,
  playerDirectory: path.join(repositoryRoot, "dist", "player"),
});

try {
  const api = async <T>(route: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetch(`${daemon.runtime.url}${route}`, {
      ...init,
      headers: {
        authorization: `Bearer ${appToken}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok)
      throw new Error(`${route}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<T>;
  };

  const project = await api<ProjectState>("/projects", {
    method: "POST",
    body: JSON.stringify({ name: "雷霆战机", type: "general" }),
  });
  await api("/settings/external-agents", {
    method: "PUT",
    body: JSON.stringify({ enabled: true }),
  });

  const pluginDataRoot = path.join(root, "plugin-data");
  const jobDirectory = path.join(
    pluginDataRoot,
    "gamefactory-3a",
    "jobs",
    "thunder-fighter",
  );
  await mkdir(jobDirectory, { recursive: true });
  const generated = await generateShips(jobDirectory);
  const endpoint = JSON.parse(
    await readFile(path.join(root, "external-mcp", "endpoint.json"), "utf8"),
  ) as ExternalMcpEndpoint;
  const session = await openMcpSession(endpoint);
  await callMcpTool(endpoint, session, "open_project", { project: project.id });

  const prompts: Record<AssetKey, string> = {
    player: "Thunder Fighter player ship · GameFactory",
    enemy: "Thunder Fighter enemy ship · GameFactory",
    boss: "Thunder Fighter boss ship · GameFactory",
  };
  for (const key of ["player", "enemy", "boss"] as const) {
    await callMcpTool(endpoint, session, "project_import_asset", {
      sourcePath: generated.assets[key].glbPath,
      prompt: prompts[key],
      title:
        key === "player"
          ? "CX-9 Thunder Interceptor"
          : key === "enemy"
            ? "VX Raider"
            : "Dreadnought",
    });
  }

  const canvas = await api<CanvasWorkspaceDetail>(
    `/projects/${project.id}/canvas/workspace`,
  );
  const imported = Object.fromEntries(
    (["player", "enemy", "boss"] as const).map((key) => {
      const asset = canvas.assets.find(
        (candidate) => candidate.prompt === prompts[key],
      );
      if (!asset) throw new Error(`Canvas Library asset missing for ${key}`);
      return [key, asset] as const;
    }),
  ) as Record<AssetKey, (typeof canvas.assets)[number]>;
  const board = canvas.boards[0];
  if (!board) throw new Error("Thunder Fighter has no Canvas board");
  const boardDetail = await api<{
    board: {
      nodes: Array<{
        id: string;
        type: string;
        title?: string;
        data: { assetId?: string };
      }>;
    };
  }>(`/projects/${project.id}/canvas/boards/${board.id}`);
  for (const key of ["player", "enemy", "boss"] as const) {
    const node = boardDetail.board.nodes.find(
      (candidate) =>
        candidate.type === "asset" &&
        candidate.data.assetId === imported[key].libraryAssetId,
    );
    if (!node) throw new Error(`Canvas node missing for ${key}`);
  }

  await installGame(project, imported);
  const preview = await api<{ url: string; title: string }>(
    `/projects/${project.id}/preview?reuse=1`,
    { method: "POST" },
  );
  for (const route of [
    "",
    "style.css",
    "game.js",
    "game-assets.json",
    imported.player.path,
    imported.enemy.path,
    imported.boss.path,
  ]) {
    const response = await fetch(new URL(route, `${preview.url}/`));
    if (!response.ok)
      throw new Error(`Preview asset ${route || "/"}: ${response.status}`);
  }
  for (const key of ["player", "enemy", "boss"] as const) {
    const bytes = await readFile(
      path.join(project.workspacePath, imported[key].path),
    );
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== generated.assets[key].sha256) {
      throw new Error(`Previewed ${key} GLB hash changed after import`);
    }
  }

  const state = {
    ok: true,
    daemonUrl: daemon.runtime.url,
    projectId: project.id,
    projectWorkspace: project.workspacePath,
    previewUrl: preview.url,
    canvas: { boardId: board.id },
    generated: generated.assets,
    imported: Object.fromEntries(
      (["player", "enemy", "boss"] as const).map((key) => [
        key,
        {
          path: imported[key].path,
          libraryAssetId: imported[key].libraryAssetId,
        },
      ]),
    ),
    dataDirectory: root,
  };
  await writeFile(
    path.join(root, "thunder-fighter-state.json"),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  process.stdout.write(
    "Thunder Fighter is running. Open previewUrl, play, then press Ctrl-C to stop.\n",
  );

  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.stdin.once("data", stop);
  });
} finally {
  await daemon.stop();
  await rm(preinstalled, { recursive: true, force: true });
}

async function generateShips(outputDirectory: string): Promise<GeneratedShips> {
  const script = path.join(
    gameFactoryRoot,
    "scripts",
    "thunder_fighter_generate.py",
  );
  const result = await runProcess(gameFactoryPython, [
    script,
    "--output-dir",
    outputDirectory,
  ]);
  if (result.code !== 0)
    throw new Error(
      `GameFactory generation failed (${result.code}): ${result.stderr}`,
    );
  return JSON.parse(result.stdout) as GeneratedShips;
}

async function runProcess(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: gameFactoryRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, stderr, code }));
  });
}

async function openMcpSession(endpoint: ExternalMcpEndpoint): Promise<string> {
  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${endpoint.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    }),
  });
  if (!response.ok)
    throw new Error(
      `MCP initialize failed: ${response.status} ${await response.text()}`,
    );
  const session = response.headers.get("mcp-session-id");
  if (!session) throw new Error("MCP initialize returned no session");
  await fetch(endpoint.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${endpoint.token}`,
      "content-type": "application/json",
      "mcp-session-id": session,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });
  return session;
}

async function callMcpTool(
  endpoint: ExternalMcpEndpoint,
  session: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${endpoint.token}`,
      "content-type": "application/json",
      "mcp-session-id": session,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const body = (await response.json()) as {
    result?: {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    error?: { message?: string };
  };
  if (!response.ok || body.error || body.result?.isError)
    throw new Error(
      `${name}: ${body.error?.message ?? body.result?.content?.map((item) => item.text ?? "").join("\n") ?? response.status}`,
    );
  return body.result?.content?.map((item) => item.text ?? "").join("\n") ?? "";
}

async function installGame(
  project: ProjectState,
  imported: Record<string, { path: string }>,
): Promise<void> {
  await copyFile(
    path.join(gameSource, "index.html"),
    path.join(project.workspacePath, "index.html"),
  );
  await copyFile(
    path.join(gameSource, "style.css"),
    path.join(project.workspacePath, "style.css"),
  );
  await writeFile(
    path.join(project.workspacePath, "game-assets.json"),
    `${JSON.stringify(
      {
        assets: {
          player: { glbPath: imported.player.path },
          enemy: { glbPath: imported.enemy.path },
          boss: { glbPath: imported.boss.path },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await build({
    entryPoints: [path.join(gameSource, "src", "main.ts")],
    absWorkingDir: repositoryRoot,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    outfile: path.join(project.workspacePath, "game.js"),
    sourcemap: false,
    logLevel: "silent",
  });
}
