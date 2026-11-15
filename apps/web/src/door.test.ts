import { afterEach, describe, expect, it, vi } from "vitest";
import { doorOf, keepSaving, type DoorState } from "./door";
import { useProjectStore } from "./stores/project-store";

describe("a host's door", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("is a web address in the editor's hash, or nothing", () => {
    const door = "https://studio.bravoh.ai/api/reel/abc.def";
    expect(doorOf(`#/editor?door=${encodeURIComponent(door)}`)).toBe(door);
    expect(doorOf("#/editor")).toBeUndefined();
    expect(doorOf(`#/editor?door=${encodeURIComponent("javascript:alert(1)")}`)).toBeUndefined();
    expect(doorOf("#/editor?door=not a url")).toBeUndefined();
  });

  it("sends the whole project back after a change settles, and tries again while the host is busy", async () => {
    vi.useFakeTimers();
    useProjectStore.getState().createNewProject("door");
    const answers = [409, 204];
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body?: unknown }) => {
        sent.push(String(init.body));
        return new Response(null, { status: answers.shift() ?? 204 });
      }),
    );
    const states: DoorState[] = [];
    const stop = keepSaving("https://host/door", (state) => states.push(state));
    useProjectStore.getState().renameProject("door, cut by hand");
    await vi.advanceTimersByTimeAsync(1600);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!).project.name).toBe("door, cut by hand");
    expect(states.at(-1)).toBe("busy");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toHaveLength(2);
    expect(states.at(-1)).toBe("saved");
    stop();
  });
});
