import { readFileSync, existsSync } from "node:fs";
import type { AwsPower, Cloud, CommandResult, DescribedInstance, ObservedBox } from "./types.ts";
import { powerFromAws, workloadTags } from "./types.ts";

export interface FakeBox {
  instanceId: string;
  region: string;
  power: AwsPower;
  tags: Record<string, string>;
  publicIp: string | null;
  instanceType: string | null;
  ssmOnline: boolean;
  observed: ObservedBox;
}

interface StoredFile {
  instances?: Array<{
    instanceId: string;
    region: string;
    power?: string;
    publicIp?: string | null;
    ssmOnline?: boolean;
    tags?: Record<string, string>;
    observed?: Partial<ObservedBox>;
  }>;
}

export class FakeCloud implements Cloud {
  readonly boxes = new Map<string, FakeBox>();
  readonly starts: string[] = [];
  readonly stops: string[] = [];
  readonly commands: Array<{ instanceId: string; action: string; slug: string }> = [];
  private results = new Map<string, CommandResult>();
  private sequence = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private bootMs: number;

  constructor(bootMs = 0, filePath?: string) {
    this.bootMs = bootMs;
    if (filePath && existsSync(filePath)) this.load(filePath);
  }

  load(filePath: string): void {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as StoredFile;
    for (const item of parsed.instances ?? []) {
      this.plant({
        instanceId: item.instanceId,
        region: item.region,
        power: powerFromAws(item.power ?? "stopped"),
        publicIp: item.publicIp ?? null,
        instanceType: "t3.micro",
        ssmOnline: item.ssmOnline !== false,
        tags: item.tags ?? {},
        observed: {
          systemd: item.observed?.systemd ?? [],
          pm2: item.observed?.pm2 ?? [],
          docker: item.observed?.docker ?? [],
        },
      });
    }
  }

  plant(box: FakeBox): void {
    this.boxes.set(box.instanceId, box);
  }

  /** Prepara as tags de workload no simulador. Não existe na conta AWS. */
  plantWorkload(input: {
    instanceId: string;
    region: string;
    slug: string;
    power?: AwsPower;
    publicIp?: string | null;
    systemd?: string[];
    pm2?: string[];
    docker?: string[];
    ssmOnline?: boolean;
  }): FakeBox {
    const box: FakeBox = {
      instanceId: input.instanceId,
      region: input.region,
      power: input.power ?? "stopped",
      publicIp: input.publicIp ?? null,
      instanceType: "t3.micro",
      ssmOnline: input.ssmOnline !== false,
      tags: workloadTags(input.slug),
      observed: {
        systemd: input.systemd ?? ["nginx.service"],
        pm2: input.pm2 ?? [],
        docker: input.docker ?? [],
      },
    };
    this.plant(box);
    return box;
  }

  list(): FakeBox[] {
    return [...this.boxes.values()];
  }

  settle(): void {
    for (const box of this.boxes.values()) {
      if (box.power === "starting") box.power = "running";
      if (box.power === "stopping") box.power = "stopped";
    }
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
  }

  async describeInstance(region: string, instanceId: string): Promise<DescribedInstance | null> {
    const box = this.boxes.get(instanceId);
    if (!box || box.region !== region) return null;
    return {
      instanceId: box.instanceId,
      region: box.region,
      state: box.power === "starting" ? "pending" : box.power,
      power: box.power,
      tags: { ...box.tags },
      publicIp: box.publicIp,
      instanceType: box.instanceType ?? null,
    };
  }

  async startInstance(_region: string, instanceId: string): Promise<{ requestId: string }> {
    const box = this.require(instanceId);
    this.starts.push(instanceId);
    if (box.power !== "running" && box.power !== "starting") {
      box.power = "starting";
      this.later(box, "running");
    }
    return { requestId: `fake-start-${this.starts.length}` };
  }

  async stopInstance(_region: string, instanceId: string): Promise<{ requestId: string }> {
    const box = this.require(instanceId);
    this.stops.push(instanceId);
    if (box.power !== "stopped" && box.power !== "stopping") {
      box.power = "stopping";
      this.later(box, "stopped");
    }
    return { requestId: `fake-stop-${this.stops.length}` };
  }

  async sendCommand(input: {
    region: string;
    instanceId: string;
    action: "start" | "stop" | "status";
    slug: string;
  }): Promise<{ commandId: string }> {
    const box = this.require(input.instanceId);
    if (!box.ssmOnline) throw new Error("ssm offline");
    if (input.action !== "status" && !/^[a-z0-9-]{1,64}$/.test(input.slug)) {
      throw new Error("slug");
    }
    this.commands.push({ instanceId: input.instanceId, action: input.action, slug: input.slug });
    const commandId = `fake-cmd-${++this.sequence}`;
    const stdout =
      input.action === "status"
        ? JSON.stringify(box.observed)
        : JSON.stringify({ ok: true, action: input.action, slug: input.slug });
    this.results.set(commandId, { status: "Success", stdout, stderr: "" });
    return { commandId };
  }

  async getCommandResult(_region: string, commandId: string, _instanceId: string): Promise<CommandResult> {
    return this.results.get(commandId) ?? { status: "Failed", stdout: "", stderr: "missing" };
  }

  async ssmOnline(_region: string, instanceId: string): Promise<boolean> {
    return this.boxes.get(instanceId)?.ssmOnline ?? false;
  }

  private require(instanceId: string): FakeBox {
    const box = this.boxes.get(instanceId);
    if (!box) throw new Error(`instância ausente no simulador: ${instanceId}`);
    return box;
  }

  private later(box: FakeBox, next: AwsPower): void {
    if (this.bootMs <= 0) {
      box.power = next;
      return;
    }
    this.timers.push(
      setTimeout(() => {
        if ((next === "running" && box.power === "starting") || (next === "stopped" && box.power === "stopping")) {
          box.power = next;
        }
      }, this.bootMs),
    );
  }
}
