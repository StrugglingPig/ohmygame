import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentTools } from "../src/daemon/agent-tools.js";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import { readAssetMetadata } from "../src/daemon/asset-metadata.js";
import { CanvasStore } from "../src/daemon/canvas-workspace.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { createProjectAssetImportTool } from "../src/daemon/project-asset-import.js";
import { ToolRunner } from "../src/daemon/tools.js";
import { TEST_GLB } from "./model3d-fixture.js";

async function setup() {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "ohmygame-project-asset-import-"),
  );
  const library = new AssetLibrary(dataDirectory);
  const projects = new ProjectManager(dataDirectory, library);
  await Promise.all([library.load(), projects.load()]);
  const project = await projects.create("Asset Import", "general");
  const runner = new ToolRunner(dataDirectory, {
    generate: async () => ({
      bytes: Buffer.from("image"),
      mediaType: "image/webp",
    }),
  });
  await runner.load();
  const canvasStore = new CanvasStore(projects, library, runner);
  const pluginDataRoot = path.join(dataDirectory, "plugin-data");
  const jobDirectory = path.join(pluginDataRoot, "job-1");
  await mkdir(jobDirectory, { recursive: true });
  const tool = createAgentTools(
    project,
    runner,
    projects,
    undefined,
    undefined,
    undefined,
    undefined,
    canvasStore,
    pluginDataRoot,
  ).find((candidate) => candidate.name === "project_import_asset");
  if (!tool) throw new Error("Expected project_import_asset tool");
  return {
    dataDirectory,
    library,
    projects,
    project,
    canvasStore,
    pluginDataRoot,
    jobDirectory,
    tool,
  };
}

describe("project asset import", () => {
  it("copies a plugin artifact into the Library and references it on the canvas", async () => {
    const { library, projects, project, canvasStore, jobDirectory, tool } =
      await setup();
    const source = path.join(jobDirectory, "prop.glb");
    await writeFile(source, TEST_GLB);

    const result = await tool.execute(
      "import",
      { sourcePath: source, prompt: "A test prop", title: "Imported prop" },
      undefined,
      undefined,
      {} as never,
    );
    const details = result.details as {
      asset: { path: string; libraryAssetId: string; sha256: string };
      canvas: { boardId: string; nodeId: string; created: boolean };
    };

    const sha256 = createHash("sha256").update(TEST_GLB).digest("hex");
    expect(details.asset.path).toBe(
      `assets/generated/prop-${sha256.slice(0, 12)}.glb`,
    );
    expect(details.asset.sha256).toBe(sha256);
    expect(
      await readFile(path.join(project.workspacePath, details.asset.path)),
    ).toEqual(TEST_GLB);

    const metadata = await readAssetMetadata(project.workspacePath);
    expect(metadata.libraryAssets[details.asset.path]).toBe(
      details.asset.libraryAssetId,
    );
    expect(metadata.prompts[details.asset.path]).toBe("A test prop");
    expect(library.get(details.asset.libraryAssetId)).toMatchObject({
      mediaType: "model",
      origin: "generated",
      purpose: "asset",
      prompt: "A test prop",
    });

    const board = await canvasStore.board(project.id, details.canvas.boardId);
    const node = board.board.nodes.find(
      (candidate) => candidate.id === details.canvas.nodeId,
    );
    expect(node).toMatchObject({
      type: "asset",
      title: "Imported prop",
      data: { assetId: details.asset.libraryAssetId, mediaType: "model" },
    });

    const manifest = JSON.parse(
      await readFile(
        path.join(project.workspacePath, "canvas", "assets.json"),
        "utf8",
      ),
    ) as {
      assets: Record<string, { path: string; libraryAssetId: string }>;
    };
    expect(manifest.assets[details.asset.libraryAssetId]).toMatchObject({
      path: details.asset.path,
      libraryAssetId: details.asset.libraryAssetId,
    });

    const again = await tool.execute(
      "import-again",
      { sourcePath: source, prompt: "A test prop", title: "Imported prop" },
      undefined,
      undefined,
      {} as never,
    );
    const repeated = again.details as typeof details;
    expect(repeated.asset.libraryAssetId).toBe(details.asset.libraryAssetId);
    expect(repeated.canvas).toEqual({ ...details.canvas, created: false });
    expect(
      (await canvasStore.board(project.id, details.canvas.boardId)).board.nodes,
    ).toHaveLength(1);
    expect(await projects.list()).toHaveLength(1);
  });

  it("rejects a source outside the plugin data directory", async () => {
    const { dataDirectory, tool } = await setup();
    const outside = path.join(dataDirectory, "outside.glb");
    await writeFile(outside, TEST_GLB);

    await expect(
      tool.execute(
        "outside",
        { sourcePath: outside },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/plugin data directory/i);
  });

  it("rejects a symlink that resolves outside the plugin data directory", async () => {
    const { dataDirectory, jobDirectory, tool } = await setup();
    const outside = path.join(dataDirectory, "outside.glb");
    const link = path.join(jobDirectory, "linked.glb");
    await writeFile(outside, TEST_GLB);
    await symlink(outside, link);

    await expect(
      tool.execute(
        "symlink",
        { sourcePath: link },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/plugin data directory/i);
  });

  it("rejects unsupported media instead of copying arbitrary plugin files", async () => {
    const { jobDirectory, tool } = await setup();
    const source = path.join(jobDirectory, "notes.txt");
    await writeFile(source, "not a media asset");

    await expect(
      tool.execute(
        "unsupported",
        { sourcePath: source },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/supported media/i);
  });

  it("enforces the configured import size limit", async () => {
    const { project, projects, canvasStore, jobDirectory, pluginDataRoot } =
      await setup();
    const source = path.join(jobDirectory, "large.glb");
    await writeFile(source, TEST_GLB);
    const limited = createProjectAssetImportTool({
      project,
      projects,
      canvasStore,
      pluginDataRoot,
      maxBytes: 8,
    });

    await expect(
      limited.execute(
        "large",
        { sourcePath: source },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/import limit/i);
  });
});
