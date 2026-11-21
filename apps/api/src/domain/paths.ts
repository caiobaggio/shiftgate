export const DEFAULT_IDLE_IGNORE = ["/health", "/internal/gate/*", "/favicon.ico", "/__shiftgate/*"];

/** Abrir a raiz ou a tela de login liga a EC2, como no Vortex. */
export const DEFAULT_WAKE_PATHS = ["GET /", "GET /login"];

/** Segunda a sexta, 05:00–18:00. O turno que a ficha nova já traz. */
export const DEFAULT_WEEKDAY_SHIFT: Array<{ weekday: number; start_local: string; end_local: string }> = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  start_local: "05:00",
  end_local: "18:00",
}));

export const DEFAULT_INFRA = [
  "nginx",
  "caddy",
  "amazon-ssm-agent",
  "snap.amazon-ssm-agent.amazon-ssm-agent",
  "sshd",
  "ssh",
  "chronyd",
  "chrony",
  "crond",
  "cron",
  "snapd",
  "docker",
  "containerd",
  "acpid",
  "dbus",
  "systemd-hostnamed",
  "systemd-timedated",
  "fwupd",
  "getty@tty1",
  "irqbalance",
  "modemmanager",
  "multipathd",
  "networkd-dispatcher",
  "polkit",
  "rsyslog",
  "serial-getty@ttys0",
  "systemd-journald",
  "systemd-logind",
  "systemd-networkd",
  "systemd-resolved",
  "systemd-udevd",
  "udisks2",
  "unattended-upgrades",
  "user@1000",
];

function matchPath(pathname: string, pattern: string): boolean {
  if (pattern.endsWith("*")) return pathname.startsWith(pattern.slice(0, -1));
  if (pattern.endsWith("/")) {
    const prefix = pattern;
    return pathname === pattern.slice(0, -1) || pathname.startsWith(prefix);
  }
  return pathname === pattern;
}

export function pathnameOf(path: string): string {
  const clean = path.split("?")[0] || "/";
  return clean.startsWith("/") ? clean : `/${clean}`;
}

/** Regras `MÉTODO /caminho` ou `MÉTODO /prefixo*`. A allowlist só abre o wake. */
export function wakePathAllowed(method: string, path: string, rules: string[]): boolean {
  const pathname = pathnameOf(path);
  for (const rule of rules) {
    const trimmed = rule.trim();
    const space = trimmed.indexOf(" ");
    if (space === -1) continue;
    const ruleMethod = trimmed.slice(0, space).toUpperCase();
    const pattern = trimmed.slice(space + 1).trim();
    if (ruleMethod !== "*" && ruleMethod !== method.toUpperCase()) continue;
    if (matchPath(pathname, pattern)) return true;
  }
  return false;
}

export function idleIgnored(path: string, rules: string[]): boolean {
  const pathname = pathnameOf(path);
  for (const rule of rules) {
    const pattern = rule.trim();
    if (!pattern) continue;
    if (matchPath(pathname, pattern)) return true;
  }
  return false;
}
