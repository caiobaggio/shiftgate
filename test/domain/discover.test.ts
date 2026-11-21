import { describe, expect, it } from "vitest";
import { classifyDiscover } from "../../apps/api/src/domain/discover.ts";
import { DEFAULT_INFRA } from "../../apps/api/src/domain/paths.ts";

describe("discover", () => {
  it("infra e workload conhecido passam; unit estranha bloqueia", () => {
    const clean = classifyDiscover(
      { systemd: ["nginx.service", "fluxo-scripts.service"], pm2: [], docker: [] },
      ["fluxo-scripts"],
      DEFAULT_INFRA,
    );
    expect(clean.clean).toBe(true);

    const dirty = classifyDiscover(
      { systemd: ["nginx.service", "algum-vizinho.service"], pm2: ["solto"], docker: [] },
      ["fluxo-scripts"],
      DEFAULT_INFRA,
    );
    expect(dirty.clean).toBe(false);
    expect(dirty.unknown.systemd).toEqual(["algum-vizinho.service"]);
    expect(dirty.unknown.pm2).toEqual(["solto"]);
  });
});
