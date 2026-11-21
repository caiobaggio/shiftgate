import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderWait } from "../../apps/edge/src/pages.ts";

describe("Worker", () => {
  it("não traz hostname nem instance id no código", () => {
    const source = ["apps/edge/src/index.ts", "apps/edge/src/pages.ts"]
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(source).not.toContain("mundomoveis");
    expect(source).not.toContain("i-0af76");
    expect(source).not.toContain("18.117.");
    expect(renderWait("Ligando a instância.", "2026-10-22T15:00:00.000Z", "req")).toContain("Ligando");
    expect(renderWait("Ligando a instância.", "2026-10-22T15:00:00.000Z", "req")).toContain("location.reload");
  });
});
