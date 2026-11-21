import { describe, expect, it } from "vitest";
import { originHealthRequest } from "../../apps/api/src/cloud/health.ts";

describe("sonda no IP de origem", () => {
  it("abre TLS no Elastic IP com o nome do health", () => {
    const spec = originHealthRequest("https://vortex-fiscal.mundomoveis.tech/backend/health", "52.15.206.114");
    expect(spec).toEqual({
      protocol: "https:",
      host: "52.15.206.114",
      servername: "vortex-fiscal.mundomoveis.tech",
      port: 443,
      path: "/backend/health",
      headers: { host: "vortex-fiscal.mundomoveis.tech" },
    });
  });

  it("ignora endereço que não é IPv4", () => {
    expect(originHealthRequest("https://app.example/health", "origem.example")).toBeNull();
  });
});
