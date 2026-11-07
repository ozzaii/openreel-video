import { describe, expect, it } from "vitest";
import { VideoEffectsEngine } from "./video-effects-engine";

// Every effect the agent's schema offers must move pixels across its declared range.
// 11-07: vignette and grain divided their 0..1 amount by 100, so a graded reel kept the cost and lost the look.
const engine = () => new VideoEffectsEngine({ width: 4, height: 4 }) as unknown as {
  applyVignette(d: Uint8ClampedArray, w: number, h: number, a: number, m: number, f: number): void;
  applyGrain(d: Uint8ClampedArray, a: number): void;
  buildCSSFilter(e: { type: string; params: Record<string, number> }): string;
};
const grey = () => new Uint8ClampedArray(4 * 4 * 4).fill(128);

describe("effect scale", () => {
  it("vignette amount 1 darkens the corners by most of the way", () => {
    const d = grey();
    engine().applyVignette(d, 4, 4, 1, 0.5, 0.3);
    expect(d[0]).toBeLessThan(64);
  });
  it("grain amount 0.5 moves pixels by more than rounding", () => {
    const d = grey();
    engine().applyGrain(d, 0.5);
    const moved = d.filter((v, i) => i % 4 === 0 && Math.abs(v - 128) > 1).length;
    expect(moved).toBeGreaterThan(0);
  });
  it("brightness -0.1 is 10 percent, 12 stays 12 percent", () => {
    const e = engine();
    expect(e.buildCSSFilter({ type: "brightness", params: { value: -0.1 } })).toBe("brightness(0.9)");
    expect(e.buildCSSFilter({ type: "brightness", params: { value: 12 } })).toBe("brightness(1.12)");
  });
});
