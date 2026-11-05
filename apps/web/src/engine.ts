// Engine boot mode (#engine=<project key>): the editor without its screens, driven by a host
// through OpenReel's own tool dispatcher — the one the desktop MCP bridge forwards to.
import { buildSystemPrompt, selectToolsForPrompt, toAnthropicTools, type ToolResult } from "@openreel/agent";
import { createProjectSerializer, createStorageEngine } from "@openreel/core";
import { handleMcpBridgeRequest, type McpBridgeRequest } from "./services/agent/mcp-listener";
import { getLiveEditorHost } from "./services/agent/host-singleton";
import { createExportJobRunner, getLastExport } from "./services/agent/export-job-runner";
import { fetchInPage } from "./services/agent/live-host";
import { useEngineStore } from "./stores/engine-store";
import { useProjectStore } from "./stores/project-store";

export interface Engine {
  readonly ready: Promise<void>;
  tools(): Promise<Array<{ name: string; description: string; inputSchema: unknown }>>;
  /** Their agent's own turn setup for a brief: the router's subset, the system prompt over it, its schemas. */
  prompt(brief: string): Promise<{ system: string; tools: ReturnType<typeof toAnthropicTools> }>;
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
    ready: useEngineStore.getState().initialize(),
    tools: async () => (await dispatch({ kind: "listTools" })) as Awaited<ReturnType<Engine["tools"]>>,
    // As packages/agent-runner/src/run.ts sets up a headless turn, against the live editor.
    prompt: async (brief) => {
      const names = selectToolsForPrompt(brief);
      return { system: buildSystemPrompt(getLiveEditorHost(), names), tools: toAnthropicTools(names) };
    },
    call: async (name, args = {}) => (await dispatch({ kind: "callTool", name, args })) as ToolResult,
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
