// Engine boot mode (#engine=<project key>): the editor without its screens, driven by a host
// through OpenReel's own dispatchers: their current chat's curated catalog (editing-tools.ts, on an
// atomic EditingSession per call) and every other registry tool, through the desktop MCP bridge's dispatcher.
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
import { PORTABLE_VIDEO_EFFECTS } from "@openreel/core/editing/portable-project";

export interface Engine {
  readonly ready: Promise<void>;
  tools(): Promise<Array<{ name: string; description: string; inputSchema: unknown }>>;
  /** What their current chat sends a model: its system prompt and tools, plus what a host off the turn needs. */
  catalog(): Promise<{ system: string; tools: unknown[] }>;
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  save(): Promise<string>;
  load(json: string): Promise<void>;
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
 * THE WHOLE STUDIO, ONE FIXED LIST: every registry tool, and their chat's curated tools (editing-tools.ts) in
 * place of the registry's where a name is both, as `call` runs them there. Sorted by name and built from module
 * constants, so it is the same bytes on every page: a host's static prefix, with no router changing it per brief.
 */
const DRAFTED = "Tools operate on an isolated draft and the whole turn commits atomically.";
const REFUSED = "No network media downloads, arbitrary scripts, custom shaders, automatic transcription or generative media tools are available here. ";

/**
 * Video effects past their chat's eight numeric ones (a shader, glow, chromatic aberration): the registry's
 * add/update_video_effect take them, and `call` sends such an effect there. The catalog carries the registry's
 * entry with their chat's parameter ranges beside it.
 */
const WIDER = new Set(["add_video_effect", "update_video_effect"]);
const portable = (name: string, args: Record<string, unknown>): boolean => {
  const type =
    name === "add_video_effect"
      ? args.effectType
      : useProjectStore
          .getState()
          .project.timeline.tracks.flatMap((track) => track.clips)
          .find((clip) => clip.id === args.clipId)
          ?.effects.find((effect) => effect.id === args.effectId)?.type;
  return (PORTABLE_VIDEO_EFFECTS as readonly unknown[]).includes(type);
};
const chatRuns = (name: string, args: Record<string, unknown>): boolean =>
  name in EDIT_TOOL_SCHEMAS && (!WIDER.has(name) || portable(name, args));

export function catalog(): { system: string; tools: unknown[] } {
  const chat = (editingToolDefs("anthropic") as Array<{ name: string; description: string }>).filter(
    (t) => t.name !== "open_export",
  );
  const curated = new Set(chat.filter((t) => !WIDER.has(t.name)).map((t) => t.name));
  const registry = toAnthropicTools().map((t) =>
    WIDER.has(t.name)
      ? { ...t, description: `${t.description} ${chat.find((c) => c.name === t.name)?.description ?? ""}`.trim() }
      : t,
  );
  const tools = [...chat.filter((t) => curated.has(t.name)), ...registry.filter((t) => !curated.has(t.name))].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  // The families the page itself holds (public/fonts): a text clip's fontFamily is one of these, or it falls back.
  const fonts = [...new Set(Object.values(FONT_CATEGORIES).flat())].join(", ");
  const system = EDITING_SYSTEM.replace(REFUSED, "").replace(
    DRAFTED,
    `Their chat's curated tools (${[...curated].sort().join(", ")}) operate on an isolated draft committed whole per call; every other tool is the registry's and applies directly.`,
  );
  return { system: `${system}\n\nFonts this editor holds: ${fonts}.`, tools };
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

/** The timeline as it would export, at each second, tiled into one JPEG with its time on it. Through `call`: a host's method list stays as it is. */
async function seeFrames({ times, long = 480 }: { times: number[]; long?: number }): Promise<ToolResult> {
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
  return { ok: true, summary: `${columns}x${rows} frames`, data: { jpeg: btoa(binary), columns, rows } };
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
      name === "see_frames"
        ? seeFrames(args as { times: number[]; long?: number })
        : chatRuns(name, args)
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
