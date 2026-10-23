import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  defineTool,
  type ToolDefinition as PiToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
  AssetCanvasNode,
  LibraryAsset,
  ProjectState,
} from "../shared/contracts.js";
import { fitCanvasLayout } from "../shared/canvas-workspace.js";
import { mediaFileInfo } from "../shared/media-files.js";
import type { CanvasStore } from "./canvas-workspace.js";
import type { ProjectManager } from "./projects.js";

export const PROJECT_IMPORT_ASSET_TOOL_NAME = "project_import_asset";
export const MAX_PROJECT_IMPORT_BYTES = 100 * 1024 * 1024;

export interface ProjectAssetImportOptions {
  project: ProjectState;
  projects: ProjectManager;
  canvasStore: CanvasStore;
  /** Only media at or below this directory can cross from a plugin into a project. */
  pluginDataRoot: string;
  maxBytes?: number;
}

interface ImportSource {
  absolutePath: string;
  fileName: string;
  mediaType: LibraryAsset["mediaType"];
  size: number;
}

export function createProjectAssetImportTool(
  options: ProjectAssetImportOptions,
): PiToolDefinition {
  const maxBytes = options.maxBytes ?? MAX_PROJECT_IMPORT_BYTES;
  return defineTool({
    name: PROJECT_IMPORT_ASSET_TOOL_NAME,
    label: "Import Plugin Asset",
    description: [
      "Import a media file produced by an enabled local plugin into the current project.",
      "The source must be inside OhMyGame's private plugin-data directory. The tool checks the file, copies it into the project, registers it in the Asset Library, and adds its Asset node to a Canvas board.",
      "Use this after a plugin finishes generating media; do not use it to copy arbitrary workspace or user files.",
    ].join(" "),
    parameters: Type.Object({
      sourcePath: Type.String({
        minLength: 1,
        maxLength: 4096,
        description:
          "Absolute path to a supported media file under OhMyGame's plugin-data directory",
      }),
      prompt: Type.Optional(
        Type.String({
          maxLength: 4_000,
          description:
            "Generation prompt or provenance to retain with the imported asset",
        }),
      ),
      title: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 200,
          description: "Title for the new Canvas Asset node",
        }),
      ),
      boardId: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 100,
          pattern: "^[a-zA-Z0-9_-]+$",
          description:
            "Canvas board to receive the Asset node; defaults to the first board",
        }),
      ),
    }),
    execute: async (_toolCallId, input, signal) => {
      signal?.throwIfAborted();
      const source = await resolveImportSource(
        options.pluginDataRoot,
        input.sourcePath,
        maxBytes,
      );
      signal?.throwIfAborted();
      const bytes = await readFile(source.absolutePath);
      signal?.throwIfAborted();
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const parsedName = path.parse(source.fileName);
      const fileName = `${parsedName.name.slice(0, 80)}-${sha256.slice(0, 12)}${parsedName.ext}`;
      const prompt = input.prompt?.trim();
      const title = input.title?.trim();
      const assetPath = await options.projects.addGeneratedAsset(
        options.project.id,
        fileName,
        bytes,
        {
          ...(prompt ? { prompt } : {}),
        },
      );
      const libraryAssetId = await options.projects.ensureLibraryAsset(
        options.project.id,
        assetPath,
      );
      signal?.throwIfAborted();
      const canvas = await referenceImportedAsset({
        project: options.project,
        canvasStore: options.canvasStore,
        libraryAssetId,
        mediaType: source.mediaType,
        ...(input.boardId ? { boardId: input.boardId } : {}),
        ...(title ? { title } : {}),
      });
      return {
        content: [
          {
            type: "text",
            text: `Imported ${source.fileName} as ${libraryAssetId} and referenced it on Canvas board ${canvas.boardId}.`,
          },
        ],
        details: {
          asset: {
            path: assetPath,
            libraryAssetId,
            sha256,
            fileName,
            mediaType: source.mediaType,
            size: bytes.byteLength,
          },
          canvas,
        },
      };
    },
  });
}

async function resolveImportSource(
  root: string,
  requested: string,
  maxBytes: number,
): Promise<ImportSource> {
  const rootPath = await realpath(root).catch(() => {
    throw new Error("OhMyGame's plugin data directory is not available");
  });
  const absolutePath = await realpath(requested).catch(() => {
    throw new Error("Plugin asset source does not exist");
  });
  const relative = path.relative(rootPath, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      "Plugin asset source must be inside OhMyGame's plugin data directory",
    );
  }
  const details = await lstat(absolutePath);
  if (!details.isFile()) throw new Error("Plugin asset source must be a file");
  if (details.size > maxBytes)
    throw new Error(
      `Plugin asset exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MiB import limit`,
    );
  const fileName = path.basename(absolutePath);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(fileName))
    throw new Error(
      "Plugin asset name must use letters, numbers, dots, dashes, or underscores",
    );
  const media = mediaFileInfo(fileName);
  if (!media) throw new Error("Plugin asset is not a supported media file");
  return {
    absolutePath,
    fileName,
    mediaType: media.mediaType,
    size: details.size,
  };
}

async function referenceImportedAsset(input: {
  project: ProjectState;
  canvasStore: CanvasStore;
  libraryAssetId: string;
  mediaType: LibraryAsset["mediaType"];
  boardId?: string;
  title?: string;
}): Promise<{ boardId: string; nodeId: string; created: boolean }> {
  const workspace = await input.canvasStore.workspace(input.project.id);
  const boardId = input.boardId ?? workspace.boards[0]?.id;
  if (!boardId || !workspace.boards.some((board) => board.id === boardId))
    throw new Error("Canvas board not found");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const detail = await input.canvasStore.board(input.project.id, boardId);
    const existing = detail.board.nodes.find(
      (node) =>
        node.type === "asset" && node.data.assetId === input.libraryAssetId,
    );
    if (existing) return { boardId, nodeId: existing.id, created: false };

    const id = randomUUID();
    const provisional = {
      id,
      type: "asset",
      position: { x: 0, y: 0 },
      data: { assetId: input.libraryAssetId, mediaType: input.mediaType },
      ...(input.title ? { title: input.title } : {}),
    } satisfies AssetCanvasNode;
    const editorLayout = fitCanvasLayout(
      [...detail.board.nodes, provisional],
      detail.board.editorLayout,
    );
    const position = editorLayout.nodes[id]!;
    const node: AssetCanvasNode = {
      ...provisional,
      position: { x: position.x, y: position.y },
    };
    const board = {
      ...detail.board,
      nodes: [...detail.board.nodes, node],
      editorLayout,
    };
    try {
      await input.canvasStore.saveBoard(
        input.project.id,
        board,
        detail.revision,
      );
      return { boardId, nodeId: id, created: true };
    } catch (cause) {
      if (
        attempt === 0 &&
        (cause as { statusCode?: number }).statusCode === 409
      )
        continue;
      throw cause;
    }
  }
  throw new Error("Canvas board changed while importing the asset");
}
