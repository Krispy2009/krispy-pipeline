import { describe as suite, expect, it } from "vitest";
import { NAME, describe } from "./index.js";

suite("index", () => {
  it("exposes the package name and a description", () => {
    expect(NAME).toBe("krispy-pipeline");
    expect(describe()).toBe("krispy-pipeline launcher");
  });
});
