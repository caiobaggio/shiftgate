import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  port: number;
  databasePath: string;
  awsRegion: string;
  awsAdapter: "fake" | "ec2";
  controlPlaneInstanceId: string;
  panelPublicOrigin: string;
  edgeSecrets: string[];
  sessionSecret: string;
  accessTeamDomain: string;
  accessAud: string;
  webhookUrl: string;
  timezone: string;
  devAuth: boolean;
  bootstrapAdminEmail: string;
  tickMs: number;
  fakeBootMs: number;
  fakeHealthFollowsPower: boolean;
  seedPath: string;
  fakeCloudPath: string;
  webDist: string;
  root: string;
  simulatedSkewMs: number;
  ssmDocument: string;
}

export function repoRoot(): string {
  return fileURLToPath(new URL("../../..", import.meta.url));
}

function fromRoot(root: string, value: string): string {
  return isAbsolute(value) ? value : join(root, value);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const root = repoRoot();
  const production = env.NODE_ENV === "production";
  const edgeSecrets = (env.EDGE_SHARED_SECRETS ?? (production ? "" : "dev-edge-secret"))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const sessionSecret = env.SESSION_SECRET ?? (production ? "" : "dev-session-secret");
  if (production && (edgeSecrets.length === 0 || !sessionSecret)) {
    throw new Error("EDGE_SHARED_SECRETS e SESSION_SECRET são obrigatórios em produção.");
  }
  const databasePath = fromRoot(root, env.DATABASE_PATH ?? join("data", "shiftgate.sqlite"));
  return {
    port: Number(env.PORT ?? 8080),
    databasePath,
    awsRegion: env.AWS_REGION ?? "us-east-2",
    awsAdapter: env.AWS_ADAPTER === "ec2" ? "ec2" : "fake",
    controlPlaneInstanceId: env.CONTROL_PLANE_INSTANCE_ID ?? "",
    panelPublicOrigin: env.PANEL_PUBLIC_ORIGIN ?? "http://localhost:5173",
    edgeSecrets,
    sessionSecret,
    accessTeamDomain: env.ACCESS_TEAM_DOMAIN ?? "",
    accessAud: env.ACCESS_AUD ?? "",
    webhookUrl: env.WEBHOOK_URL ?? "",
    timezone: env.TZ || "America/Sao_Paulo",
    devAuth: env.DEV_AUTH === "1",
    bootstrapAdminEmail: env.BOOTSTRAP_ADMIN_EMAIL ?? "",
    tickMs: Number(env.TICK_MS ?? 15_000),
    fakeBootMs: Number(env.FAKE_BOOT_MS ?? 0),
    fakeHealthFollowsPower: env.FAKE_HEALTH !== "off" && env.AWS_ADAPTER !== "ec2",
    seedPath: fromRoot(root, env.SEED_PATH ?? join("seed", "mm-root.seed.json")),
    fakeCloudPath: fromRoot(root, env.FAKE_CLOUD_PATH ?? join("seed", "fake-cloud.json")),
    webDist: join(root, "apps", "web", "dist"),
    root,
    simulatedSkewMs: Number(env.SIMULATED_SKEW_MS ?? readSkew(env.SKEW_FILE)),
    ssmDocument: env.SSM_DOCUMENT ?? "shiftgate-service-control",
  };
}

function readSkew(file: string | undefined): number {
  if (!file || !existsSync(file)) return 0;
  const parsed = Number(readFileSync(file, "utf8").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}
