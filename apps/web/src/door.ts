// A HOST'S DOOR (`#/editor?door=<url>`): a host (BRAVOH) opens one project here in the whole editor. The door's GET
// answers the project's JSON with its media at fresh links; every change goes back as a PUT of the whole project, a
// moment after the last edit; a video the artist exports is also sent through the door (`<door>/cut`). The door is a
// capability URL, so the page needs no cookie of the host's and can live on its own origin.
import { useEngineStore } from "./stores/engine-store";
import { toast } from "./stores/notification-store";
import { useProjectStore } from "./stores/project-store";
import { sendExportsTo } from "./services/export-runner";
import { openSaved, serializer } from "./services/open-saved";

export type DoorState = "opening" | "saved" | "saving" | "failed" | "busy";

/** How long after the last change the project goes back: a drag is many changes. */
const SETTLE_MS = 1500;
/** A save the host did not take is tried again this often, so an edit is never left only in this tab. */
const RETRY_MS = 10_000;

/** The door named in the hash, when it is a web address; a page without one is the plain editor. */
export const doorOf = (hash: string): string | undefined => {
  const door = new URLSearchParams(hash.split("?")[1] ?? "").get("door");
  if (!door) return undefined;
  try {
    const url = new URL(door);
    return /^https?:$/.test(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
};

const now = () => serializer().exportToJson(useProjectStore.getState().getFullProject());

/**
 * The door's project, opened with its media whole (the engine first: loading text and shape clips needs it). Once a
 * page: a second open racing the first (React's development double effect) breaks the first one's relink.
 */
let opening: Promise<void> | undefined;
export const openDoor = (door: string): Promise<void> =>
  (opening ??= (async () => {
    await useEngineStore.getState().initialize();
    const res = await fetch(door, { cache: "no-store" });
    if (!res.ok) throw new Error(`The host answered ${res.status}`);
    await openSaved(await res.text());
  })());

/**
 * Every change back through the door, and each export: what the host holds is what this tab shows. A host
 * that answers 409 is busy with the project itself (BRAVOH cutting it); the save waits and goes after.
 */
export function keepSaving(door: string, say: (state: DoorState) => void): () => void {
  let sent = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let line = Promise.resolve();
  let state: DoorState = "saved";
  const set = (next: DoorState) => {
    state = next;
    say(next);
  };
  const later = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(save, ms);
  };
  const save = () => {
    line = line.then(async () => {
      const json = now();
      if (json === sent) return set("saved");
      set("saving");
      const res = await fetch(door, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: json,
      }).catch(() => undefined);
      if (res?.ok) {
        sent = json;
        return set(now() === sent ? "saved" : "saving");
      }
      set(res?.status === 409 ? "busy" : "failed");
      later(RETRY_MS);
    });
  };
  const unsubscribe = useProjectStore.subscribe((next, previous) => {
    if (next.project === previous.project) return;
    if (state === "saved") set("saving");
    later(SETTLE_MS);
  });
  const leaving = (event: BeforeUnloadEvent) => {
    if (state !== "saved") event.preventDefault();
  };
  window.addEventListener("beforeunload", leaving);
  sendExportsTo((file, name) => {
    // By its name: a file read back from the origin's private storage comes with no type.
    if (!/\.(mp4|mov|webm)$/i.test(name)) return;
    void fetch(`${door}/cut?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
    })
      .then((res) => (res.ok ? toast.success("Sent to BRAVOH", name) : Promise.reject(new Error(`HTTP ${res.status}`))))
      .catch(() => toast.error("The video did not reach BRAVOH", "It is still in your downloads."));
  });
  return () => {
    clearTimeout(timer);
    unsubscribe();
    sendExportsTo(undefined);
    window.removeEventListener("beforeunload", leaving);
  };
}
