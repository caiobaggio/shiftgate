import type { Power } from "../../../../packages/contracts/src/index.ts";

export type AwsPower = Exclude<Power, "blocked">;

export interface DescribedInstance {
  instanceId: string;
  region: string;
  state: string;
  power: AwsPower;
  tags: Record<string, string>;
  publicIp: string | null;
  instanceType: string | null;
}

export interface CommandResult {
  status: "Success" | "Failed" | "Pending";
  stdout: string;
  stderr: string;
}

export interface Cloud {
  describeInstance(region: string, instanceId: string): Promise<DescribedInstance | null>;
  startInstance(region: string, instanceId: string): Promise<{ requestId: string }>;
  stopInstance(region: string, instanceId: string): Promise<{ requestId: string }>;
  sendCommand(input: {
    region: string;
    instanceId: string;
    action: "start" | "stop" | "status";
    slug: string;
  }): Promise<{ commandId: string }>;
  getCommandResult(region: string, commandId: string, instanceId: string): Promise<CommandResult>;
  ssmOnline(region: string, instanceId: string): Promise<boolean>;
}

export interface ObservedBox {
  systemd: string[];
  pm2: string[];
  docker: string[];
}

export function powerFromAws(state: string): AwsPower {
  switch (state) {
    case "pending":
      return "starting";
    case "running":
      return "running";
    case "stopping":
    case "shutting-down":
      return "stopping";
    case "stopped":
      return "stopped";
    default:
      return "error";
  }
}

export function tagProblem(described: DescribedInstance, slug: string): string | null {
  const tags = described.tags;
  if (tags["shiftgate:managed"] !== "true") return "shiftgate:managed";
  if (tags["shiftgate:allow-stop"] !== "true") return "shiftgate:allow-stop";
  if (tags["shiftgate:role"] !== "workload") return "shiftgate:role";
  if (tags["shiftgate:host"] !== slug) return "shiftgate:host";
  return null;
}

export function workloadTags(slug: string): Record<string, string> {
  return {
    "shiftgate:managed": "true",
    "shiftgate:allow-stop": "true",
    "shiftgate:role": "workload",
    "shiftgate:host": slug,
  };
}
