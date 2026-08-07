import { describe, it, expect } from "vitest";
import {
  createProject,
  createFeature,
  updateFeature,
  listFeatures,
  getFeatureDeps,
  getFeatureDependents,
  setFeatureDeps,
  featureDepsSatisfied,
} from "@/lib/store";
import { uid } from "./helpers";

/** A project plus n features, freshly created. */
function fixture(n: number) {
  const p = createProject({ name: `FD-${uid()}` });
  const fs = Array.from({ length: n }, (_, i) => createFeature({ project_id: p.id, name: `F${i}-${uid()}` }));
  return { p, fs };
}

describe("setFeatureDeps / getFeatureDeps", () => {
  it("round-trips, dedupes, and drops self-references", () => {
    const { fs: [a, b] } = fixture(2);
    setFeatureDeps(b.id, [a.id, a.id, b.id]);
    expect(getFeatureDeps(b.id)).toEqual([a.id]);
    expect(getFeatureDependents(a.id)).toEqual([b.id]);
    // Replace semantics: a second call swaps the set, not appends.
    setFeatureDeps(b.id, []);
    expect(getFeatureDeps(b.id)).toEqual([]);
  });

  it("drops ids from another project", () => {
    const { fs: [a] } = fixture(1);
    const other = createFeature({ project_id: createProject({ name: `FD2-${uid()}` }).id, name: `X-${uid()}` });
    setFeatureDeps(a.id, [other.id]);
    expect(getFeatureDeps(a.id)).toEqual([]);
  });

  it("throws on a cycle", () => {
    const { fs: [a, b, c] } = fixture(3);
    setFeatureDeps(b.id, [a.id]);
    setFeatureDeps(c.id, [b.id]);
    expect(() => setFeatureDeps(a.id, [c.id])).toThrow("dependency cycle");
  });

  it("joins depends_on into listFeatures", () => {
    const { p, fs: [a, b] } = fixture(2);
    setFeatureDeps(b.id, [a.id]);
    const rows = listFeatures(p.id);
    expect(rows.find((f) => f.id === b.id)!.depends_on).toEqual([a.id]);
    expect(rows.find((f) => f.id === a.id)!.depends_on).toEqual([]);
  });
});

describe("featureDepsSatisfied", () => {
  it("is true only when every dep has shipped (merged_at > 0)", () => {
    const { fs: [a, b, c] } = fixture(3);
    setFeatureDeps(c.id, [a.id, b.id]);
    expect(featureDepsSatisfied(c.id)).toBe(false);
    updateFeature(a.id, { merged_at: Date.now() });
    expect(featureDepsSatisfied(c.id)).toBe(false); // b still unshipped
    updateFeature(b.id, { merged_at: Date.now() });
    expect(featureDepsSatisfied(c.id)).toBe(true);
  });

  it("archived-without-merge does NOT satisfy", () => {
    const { fs: [a, b] } = fixture(2);
    setFeatureDeps(b.id, [a.id]);
    updateFeature(a.id, { archived: 1 }); // abandoned, never shipped
    expect(featureDepsSatisfied(b.id)).toBe(false);
  });

  it("no deps = satisfied", () => {
    const { fs: [a] } = fixture(1);
    expect(featureDepsSatisfied(a.id)).toBe(true);
  });
});
