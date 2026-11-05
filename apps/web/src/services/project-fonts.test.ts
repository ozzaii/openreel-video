import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureFontFamily, ensureProjectFonts, collectProjectFonts } from "./project-fonts";
import { createEmptyProject } from "../stores/project/project-helpers";

const load = vi.fn(async () => []);
beforeEach(() => { load.mockClear(); Object.defineProperty(document, "fonts", { value: { load }, configurable: true }); });
afterEach(() => { delete (document as unknown as { fonts?: unknown }).fonts; document.querySelectorAll('link[data-openreel-font]').forEach((link) => link.remove()); vi.restoreAllMocks(); });
describe("fonts on demand", () => {
  it("loads a family's glyphs from the page's own fonts, with no stylesheet request", async () => {
    await Promise.all([ensureFontFamily("Bangers", 400, "Olá"), ensureFontFamily("Bangers", 700, "字幕")]);
    expect(document.querySelector('link[data-openreel-font]')).toBeNull();
    expect(load).toHaveBeenCalledWith('400 48px "Bangers"', "Olá");
    expect(load).toHaveBeenCalledWith('700 48px "Bangers"', "字幕");
  });
  it("does not add network requests for startup or system fonts", async () => {
    await ensureFontFamily("Inter", 800, "Title"); await ensureFontFamily("Arial", 400);
    expect(document.querySelector('link[data-openreel-font]')).toBeNull();
  });
  it("collects caption glyphs and waits for project fonts before export", async () => {
    const project = createEmptyProject("Font sample");
    const modified = { ...project, timeline: { ...project.timeline, subtitles: [{ id: "subtitle", text: "Olá 字幕", startTime: 0, endTime: 1, style: { fontFamily: "Inter", fontSize: 24, color: "white", backgroundColor: "black", position: "bottom" as const } }] } };
    expect(collectProjectFonts(modified)).toEqual([{ family: "Inter", weight: "700", sample: "Olá 字幕" }]);
    await ensureProjectFonts(modified);
    expect(load).toHaveBeenCalledWith('700 48px "Inter"', "Olá 字幕");
  });
});
