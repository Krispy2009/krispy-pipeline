import { describe, expect, it } from "vitest";
import { NAME, banner } from "./index.js";

describe("index", () => {
  it("exposes the package name and a banner", () => {
    expect(NAME).toBe("krispy-pipeline");
    expect(banner()).toBe("krispy-pipeline launcher");
  });
});
