export interface ObservedInventory {
  systemd: string[];
  pm2: string[];
  docker: string[];
}

export interface DiscoverDiff {
  clean: boolean;
  unknown: ObservedInventory;
}

export function normalizeUnit(name: string): string {
  return name.trim().toLowerCase().replace(/\.service$/, "");
}

/** Serviço fora do cadastro e fora da allowlist de infra bloqueia StopInstances. */
export function classifyDiscover(
  observed: ObservedInventory,
  workloadUnits: string[],
  infra: string[],
): DiscoverDiff {
  const known = new Set([...workloadUnits, ...infra].map(normalizeUnit).filter(Boolean));
  const unknown: ObservedInventory = {
    systemd: observed.systemd.filter((name) => name.trim() && !known.has(normalizeUnit(name))),
    pm2: observed.pm2.filter((name) => name.trim() && !known.has(normalizeUnit(name))),
    docker: observed.docker.filter((name) => name.trim() && !known.has(normalizeUnit(name))),
  };
  const clean = unknown.systemd.length + unknown.pm2.length + unknown.docker.length === 0;
  return { clean, unknown };
}
