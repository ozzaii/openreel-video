import { describe, expect, it } from "vitest";
import { useProjectStore } from "./stores/project-store";
import { toAnthropicTools } from "@openreel/agent";
import { catalog, edit } from "./engine";
import { EDIT_TOOL_SCHEMAS } from "./services/agent/editing-tools";

describe("engine catalog", () => {
  it("is the whole registry plus their chat's own tools, sorted, the same bytes every time", () => {
    const { system, tools } = catalog();
    const names = (tools as Array<{ name: string; input_schema: unknown }>).map((t) => t.name);
    expect(system).toContain("mediaId is not a clipId");
    expect(system).not.toContain("custom shaders");
    for (const name of toAnthropicTools().map((t) => t.name)) expect(names).toContain(name);
    for (const name of ["get_transition_options", "inspect_media", "list_text_clips", "set_text_timing", "apply_edit_preset", "set_speed_ramp", "set_color_grading", "set_subtitle_style"])
      expect(names).toContain(name);
    expect(names).not.toContain("open_export");
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([...names].sort());
    // A name in both: the chat's schema, as `call` runs it through their executor.
    const addClip = (tools as Array<{ name: string; input_schema: unknown }>).find((t) => t.name === "add_clip");
    expect(addClip?.input_schema).toBe(EDIT_TOOL_SCHEMAS.add_clip);
    // A video effect past their chat's eight: the registry's entry, their ranges beside it.
    const effect = (tools as Array<{ name: string; description: string }>).find((t) => t.name === "add_video_effect");
    expect(effect?.description).toContain("shader");
    expect(effect?.description).toContain("Vignette strength is amount");
    expect(JSON.stringify(catalog())).toBe(JSON.stringify({ system, tools }));
  });

  it("commits a valid catalog call to the project and leaves it untouched on a rejected one", async () => {
    useProjectStore.getState().createNewProject("video");
    const added = await edit("add_track", { trackType: "video" });
    expect(added.ok).toBe(true);
    const tracks = () => useProjectStore.getState().project.timeline.tracks.length;
    const before = tracks();
    expect(before).toBeGreaterThan(0);
    expect((await edit("add_track", { trackType: "bogus" })).ok).toBe(false);
    expect(tracks()).toBe(before);
  });
});
