// Engine boot mode (#engine=<project key>): the editor without its screens, driven by a host
// through OpenReel's own dispatchers: their current chat's curated catalog (editing-tools.ts, on an
// atomic EditingSession per call) and, past it, the registry the desktop MCP bridge forwards to.
import { toAnthropicTools, type ToolResult } from "@openreel/agent";
import { createProjectSerializer, createStorageEngine } from "@openreel/core";
import { handleMcpBridgeRequest, type McpBridgeRequest } from "./services/agent/mcp-listener";
import { getLiveEditorHost, runExclusive } from "./services/agent/host-singleton";
import { EditingSession } from "./services/agent/editing-session";
import { EDIT_TOOL_SCHEMAS, EDITING_SYSTEM, editingToolDefs, executeEditingTool } from "./services/agent/editing-tools";
import { createExportJobRunner, getLastExport } from "./services/agent/export-job-runner";
import { fetchInPage } from "./services/agent/live-host";
import { useEngineStore } from "./stores/engine-store";
import { useProjectStore } from "./stores/project-store";
import { ensureProjectFonts } from "./services/project-fonts";
import { FONT_CATEGORIES } from "./components/editor/inspector/font-options";

export interface Engine {
  readonly ready: Promise<void>;
  tools(): Promise<Array<{ name: string; description: string; inputSchema: unknown }>>;
  /** What their current chat sends a model: its system prompt and tools, plus what a host off the turn needs. */
  catalog(): Promise<{ system: string; tools: unknown[] }>;
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  save(): Promise<string>;
  load(json: string): Promise<void>;
  /** The timeline as it would export, at each second, tiled into one JPEG with its time on it: base64. */
  frames(times: number[], long?: number): Promise<{ jpeg: string; columns: number; rows: number }>;
  exported(): Promise<{ id: string; bytes: number; type: string }>;
  chunk(id: string, start: number, size: number): Promise<string>;
}

declare global {
  interface Window {
    engine?: Engine;
  }
}

async function dispatch(req: Omit<McpBridgeRequest, "callId">): Promise<unknown> {
  const res = await handleMcpBridgeRequest({ callId: crypto.randomUUID(), ...req });
  if (!res.ok) throw new Error(res.error ?? "Engine call failed");
  return res.result;
}

/**
 * Past their chat's catalog, from the registry: media by link and a real export (the chat only opens
 * the export dialog and imports by hand), and an SRT in one call (the chat adds a subtitle at a time).
 */
const FROM_REGISTRY = ["import_media_from_url", "export_video", "import_srt"];

export function catalog(): { system: string; tools: unknown[] } {
  const chat = (editingToolDefs("anthropic") as Array<{ name: string }>).filter((t) => t.name !== "open_export");
  // The families the page itself holds (public/fonts): a text clip's fontFamily is one of these, or it falls back.
  const fonts = [...new Set(Object.values(FONT_CATEGORIES).flat())].join(", ");
  return { system: `${EDITING_SYSTEM}\n\nFonts this editor holds: ${fonts}.`, tools: [...chat, ...toAnthropicTools(FROM_REGISTRY)] };
}

/** One catalog call as their chat runs a turn (chat-store.ts): validated on a draft, committed whole or not at all. */
export async function edit(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const session = new EditingSession();
  const txn = session.beginTransaction();
  const result = await executeEditingTool(name, args, session);
  if (result.ok) await session.commitTransaction(txn, `AI edit: ${name}`);
  else await session.rollbackTransaction();
  return result;
}

const serializer = () => createProjectSerializer(createStorageEngine());

function exportedBlob(id?: string): { id: string; blob: Blob } {
  const last = getLastExport();
  if (!last) throw new Error("Nothing has been exported yet");
  if (id !== undefined && id !== last.id) throw new Error(`Export ${id} is no longer kept; the last one is ${last.id}`);
  return last;
}

export function installEngine(): void {
  getLiveEditorHost().setJobRunner(createExportJobRunner());
  window.engine = {
    // A conversation's video is open from the start, as the editor is when their chat runs; load() replaces it.
    ready: useEngineStore
      .getState()
      .initialize()
      .then(() => {
        if (!useProjectStore.getState().hasOpenProject) useProjectStore.getState().createNewProject("video");
      }),
    tools: async () => (await dispatch({ kind: "listTools" })) as Awaited<ReturnType<Engine["tools"]>>,
    catalog: async () => catalog(),
    call: async (name, args = {}) =>
      name in EDIT_TOOL_SCHEMAS
        ? runExclusive(() => edit(name, args))
        : ((await dispatch({ kind: "callTool", name, args })) as ToolResult),
    save: async () => serializer().exportToJson(useProjectStore.getState().getFullProject()),
    load: async (json) => {
      const project = serializer().importFromJson(json);
      useProjectStore.getState().loadProject(project);
      // Relink: a project saved elsewhere carries no media bytes, only the links they came from.
      for (const item of project.mediaLibrary.items) {
        if (!item.isPlaceholder || !item.originalUrl || !/^https?:/i.test(item.originalUrl)) continue;
        const res = await fetchInPage(item.originalUrl);
        if (!res.ok) throw new Error(`Relink ${item.name}: ${res.error ?? `HTTP ${res.status}`}`);
        const type = (res.contentType.split(";")[0] ?? "").trim();
        const relinked = await useProjectStore
          .getState()
          .replaceMediaAsset(item.id, new File([res.body], item.name, { type }));
        if (!relinked.success) throw new Error(`Relink ${item.name}: ${relinked.error?.message ?? "failed"}`);
      }
    },
    frames: async (times, long = 480) => {
      const { project } = useProjectStore.getState();
      const video = useEngineStore.getState().getVideoEngine();
      if (!video) throw new Error("The video engine is not ready");
      await ensureProjectFonts(project);
      const { width, height } = project.settings;
      const scale = long / Math.max(width, height);
      const w = Math.round(width * scale);
      const h = Math.round(height * scale);
      const columns = Math.min(times.length, Math.ceil(Math.sqrt(times.length * (height >= width ? 2 : 1))));
      const rows = Math.ceil(times.length / columns);
      const sheet = new OffscreenCanvas(columns * w, rows * h);
      const ctx = sheet.getContext("2d")!;
      for (const [at, time] of times.entries()) {
        const { image } = await video.renderFrame(project, time, w, h);
        const x = (at % columns) * w;
        const y = Math.floor(at / columns) * h;
        ctx.drawImage(image, x, y, w, h);
        image.close();
        ctx.font = "bold 16px sans-serif";
        const label = `${time.toFixed(2)} s`;
        ctx.fillStyle = "#000";
        ctx.fillRect(x, y, ctx.measureText(label).width + 8, 22);
        ctx.fillStyle = "#fff";
        ctx.fillText(label, x + 4, y + 16);
      }
      const bytes = new Uint8Array(await (await sheet.convertToBlob({ type: "image/jpeg", quality: 0.85 })).arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { jpeg: btoa(binary), columns, rows };
    },
    exported: async () => {
      const { id, blob } = exportedBlob();
      return { id, bytes: blob.size, type: blob.type };
    },
    chunk: async (id, start, size) => {
      const bytes = new Uint8Array(await exportedBlob(id).blob.slice(start, start + size).arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return btoa(binary);
    },
  };
}
