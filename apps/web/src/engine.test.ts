import { describe, expect, it } from "vitest";
import { useProjectStore } from "./stores/project-store";
import { catalog, edit } from "./engine";

describe("engine catalog", () => {
  it("is their chat's catalog plus import by link, a real export and SRT, without the dialog-only export", () => {
    const { system, tools } = catalog();
    const names = (tools as Array<{ name: string; input_schema: unknown }>).map((t) => t.name);
    expect(system).toContain("mediaId is not a clipId");
    for (const name of ["import_media_from_url", "export_video", "import_srt", "add_subtitle", "create_text_clip", "split_clip", "trim_clip", "add_transition", "add_video_effect", "update_project_settings"])
      expect(names).toContain(name);
    expect(names).not.toContain("open_export");
    expect(new Set(names).size).toBe(names.length);
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
