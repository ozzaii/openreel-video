import { createProjectSerializer, createStorageEngine } from "@openreel/core";
import { useProjectStore } from "../stores/project-store";
import { fetchInPage } from "./agent/live-host";

export const serializer = () => createProjectSerializer(createStorageEngine());

/**
 * A project saved elsewhere, opened here: its JSON loaded, then each media item fetched again from the
 * link it came from (`originalUrl`), since a saved project carries no media bytes. The original file,
 * never a proxy. Throws at the first link that does not answer, naming the item.
 */
export async function openSaved(json: string): Promise<void> {
  const project = serializer().importFromJson(json);
  useProjectStore.getState().loadProject(project);
  for (const item of project.mediaLibrary.items) {
    if (!item.isPlaceholder || !item.originalUrl || !/^https?:/i.test(item.originalUrl)) continue;
    const res = await fetchInPage(item.originalUrl);
    if (!res.ok) throw new Error(`Relink ${item.name}: ${res.error ?? `HTTP ${res.status}`}`);
    const type = (res.contentType.split(";")[0] ?? "").trim();
    const relinked = await useProjectStore
      .getState()
      .replaceMediaAsset(item.id, new File([res.body], item.name, { type }), undefined, { persist: false });
    if (!relinked.success) throw new Error(`Relink ${item.name}: ${relinked.error?.message ?? "failed"}`);
  }
}
