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
import { startDaemon } from "../src/desktop/daemon-process.js";
import type { CanvasWorkspaceDetail } from "../src/shared/canvas-workspace.js";
import type { ExternalMcpEndpoint } from "../src/shared/external-mcp.js";
import type { ProjectState } from "../src/shared/contracts.js";

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
  process.env.OHMYGAME_POC_DATA ??
    path.join(tmpdir(), "ohmygame-gamefactory-poc"),
);
const appToken = "gamefactory-local-poc";

interface GeneratedAsset {
  glbPath: string;
  manifestPath: string;
  sha256: string;
  bytes: number;
  triangles: number;
  gatesOk: boolean;
}

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
    body: JSON.stringify({ name: "GameFactory Local PoC", type: "general" }),
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
    "local-poc",
  );
  await mkdir(jobDirectory, { recursive: true });
  const generated = await generateWithGameFactory(jobDirectory);
  if (!generated.gatesOk)
    throw new Error("GameFactory spec gates did not pass");

  const endpoint = JSON.parse(
    await readFile(path.join(root, "external-mcp", "endpoint.json"), "utf8"),
  ) as ExternalMcpEndpoint;
  const mcpSession = await openMcpSession(endpoint);
  await callMcpTool(endpoint, mcpSession, "open_project", {
    project: project.id,
  });
  const importedText = await callMcpTool(
    endpoint,
    mcpSession,
    "project_import_asset",
    {
      sourcePath: generated.glbPath,
      prompt: "GameFactory deterministic wooden supply crate",
      title: "GameFactory Supply Crate",
    },
  );

  const canvas = await api<CanvasWorkspaceDetail>(
    `/projects/${project.id}/canvas/workspace`,
  );
  const asset = canvas.assets.find(
    (candidate) => candidate.mediaType === "model" && candidate.libraryAssetId,
  );
  if (!asset)
    throw new Error(
      "The imported GLB did not reach the Canvas Asset Library manifest",
    );
  const board = canvas.boards[0];
  if (!board) throw new Error("The project has no Canvas board");
  const boardDetail = await api<{
    board: {
      nodes: Array<{
        id: string;
        type: string;
        title?: string;
        data: { assetId?: string; mediaType?: string };
      }>;
    };
  }>(`/projects/${project.id}/canvas/boards/${board.id}`);
  const assetNode = boardDetail.board.nodes.find(
    (node) =>
      node.type === "asset" && node.data.assetId === asset.libraryAssetId,
  );
  if (!assetNode)
    throw new Error("The imported asset has no Canvas Asset node");

  await installViewer(project, asset.path);
  const preview = await api<{ url: string; title: string }>(
    `/projects/${project.id}/preview?reuse=1`,
    { method: "POST" },
  );
  const viewerResponse = await fetch(preview.url);
  if (!viewerResponse.ok)
    throw new Error(`Viewer preview failed: ${viewerResponse.status}`);
  const modelUrl = new URL(
    asset.path.split("/").map(encodeURIComponent).join("/"),
    preview.url,
  ).toString();
  const modelResponse = await fetch(modelUrl);
  if (!modelResponse.ok)
    throw new Error(`Preview could not serve the GLB: ${modelResponse.status}`);

  const state = {
    ok: true,
    daemonUrl: daemon.runtime.url,
    projectId: project.id,
    projectWorkspace: project.workspacePath,
    gameFactoryRoot,
    generated,
    importResult: importedText,
    asset,
    canvas: { boardId: board.id, nodeId: assetNode.id, title: assetNode.title },
    previewUrl: preview.url,
    modelUrl,
    dataDirectory: root,
  };
  await writeFile(
    path.join(root, "poc-state.json"),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  process.stdout.write(
    "GameFactory × OhMyGame PoC is running. Open previewUrl, then press Ctrl-C to stop.\n",
  );

  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.stdin.once("data", stop);
  });
} finally {
  await daemon.stop();
  await rm(path.join(root, "preinstalled"), { recursive: true, force: true });
}

async function generateWithGameFactory(
  outputDirectory: string,
): Promise<GeneratedAsset> {
  const script = path.join(
    gameFactoryRoot,
    "scripts",
    "ohmygame_poc_generate.py",
  );
  const result = await new Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
  }>((resolve, reject) => {
    const child = spawn(
      gameFactoryPython,
      [script, "--output-dir", outputDirectory],
      {
        cwd: gameFactoryRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
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
  if (result.code !== 0)
    throw new Error(
      `GameFactory generation failed (${result.code}): ${result.stderr}`,
    );
  return JSON.parse(result.stdout) as GeneratedAsset;
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

async function installViewer(
  project: ProjectState,
  assetPath: string,
): Promise<void> {
  const modelViewerSource = path.join(
    repositoryRoot,
    "node_modules",
    "@google",
    "model-viewer",
    "dist",
    "model-viewer.min.js",
  );
  await copyFile(
    modelViewerSource,
    path.join(project.workspacePath, "model-viewer.min.js"),
  );
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GameFactory × OhMyGame</title>
  <script type="module" src="./model-viewer.min.js"></script>
  <style>
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body { display: grid; grid-template-rows: auto 1fr auto; background: #ececec; color: #2d3142; font-family: system-ui, sans-serif; }
    header, footer { padding: 18px 24px; background: #f5f5f5; border-bottom: 1px solid rgba(45,49,66,.14); }
    footer { border-top: 1px solid rgba(45,49,66,.14); border-bottom: 0; font-size: 13px; color: #4f5d75; }
    h1 { margin: 0; font-size: 18px; font-weight: 650; }
    p { margin: 6px 0 0; color: #4f5d75; font-size: 13px; }
    model-viewer { width: 100%; height: 100%; background: radial-gradient(circle at 50% 35%, #fff 0%, #ececec 68%); }
  </style>
</head>
<body>
  <header>
    <h1>GameFactory supply crate × OhMyGame</h1>
    <p>Generated from a deterministic GameFactory spec and imported through project_import_asset.</p>
  </header>
  <model-viewer src="./${assetPath}" camera-controls auto-rotate shadow-intensity="1" exposure="1.1" camera-orbit="35deg 70deg 2.4m" id="viewer"></model-viewer>
  <footer id="status">Loading GLB…</footer>
  <script>
    const viewer = document.getElementById('viewer');
    const status = document.getElementById('status');
    viewer.addEventListener('load', () => {
      document.body.dataset.modelLoaded = 'true';
      status.textContent = 'GLB loaded and rendered.';
    });
    viewer.addEventListener('error', () => {
      document.body.dataset.modelError = 'true';
      status.textContent = 'GLB failed to load.';
    });
  </script>
</body>
</html>`;
  await writeFile(path.join(project.workspacePath, "index.html"), html, "utf8");
}
