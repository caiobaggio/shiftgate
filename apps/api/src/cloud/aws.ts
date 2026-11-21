import {
  DescribeInstancesCommand,
  EC2Client,
  StartInstancesCommand,
  StopInstancesCommand,
} from "@aws-sdk/client-ec2";
import {
  DescribeInstanceInformationCommand,
  GetCommandInvocationCommand,
  SendCommandCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import type { Cloud, CommandResult, DescribedInstance } from "./types.ts";
import { powerFromAws } from "./types.ts";

export class AwsCloud implements Cloud {
  private ec2 = new Map<string, EC2Client>();
  private ssm = new Map<string, SSMClient>();
  private documentName: string;

  constructor(documentName: string) {
    this.documentName = documentName;
  }

  private ec2Client(region: string): EC2Client {
    let client = this.ec2.get(region);
    if (!client) {
      client = new EC2Client({ region });
      this.ec2.set(region, client);
    }
    return client;
  }

  private ssmClient(region: string): SSMClient {
    let client = this.ssm.get(region);
    if (!client) {
      client = new SSMClient({ region });
      this.ssm.set(region, client);
    }
    return client;
  }

  async describeInstance(region: string, instanceId: string): Promise<DescribedInstance | null> {
    const out = await this.ec2Client(region).send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const instance = out.Reservations?.[0]?.Instances?.[0];
    if (!instance?.InstanceId || !instance.State?.Name) return null;
    const tags: Record<string, string> = {};
    for (const tag of instance.Tags ?? []) {
      if (tag.Key && tag.Value) tags[tag.Key] = tag.Value;
    }
    return {
      instanceId: instance.InstanceId,
      region,
      state: instance.State.Name,
      power: powerFromAws(instance.State.Name),
      tags,
      publicIp: instance.PublicIpAddress ?? null,
      instanceType: instance.InstanceType ?? null,
    };
  }

  async startInstance(region: string, instanceId: string): Promise<{ requestId: string }> {
    const out = await this.ec2Client(region).send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
    return { requestId: out.$metadata.requestId ?? "" };
  }

  async stopInstance(region: string, instanceId: string): Promise<{ requestId: string }> {
    const out = await this.ec2Client(region).send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
    return { requestId: out.$metadata.requestId ?? "" };
  }

  async sendCommand(input: {
    region: string;
    instanceId: string;
    action: "start" | "stop" | "status";
    slug: string;
  }): Promise<{ commandId: string }> {
    const out = await this.ssmClient(input.region).send(
      new SendCommandCommand({
        DocumentName: this.documentName,
        InstanceIds: [input.instanceId],
        Parameters: { action: [input.action], slug: [input.slug] },
      }),
    );
    const commandId = out.Command?.CommandId;
    if (!commandId) throw new Error("SSM não devolveu CommandId.");
    return { commandId };
  }

  async getCommandResult(region: string, commandId: string, instanceId: string): Promise<CommandResult> {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      try {
        const out = await this.ssmClient(region).send(
          new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId }),
        );
        const status = out.Status;
        if (status === "Success" || status === "Failed" || status === "Cancelled" || status === "TimedOut") {
          return {
            status: status === "Success" ? "Success" : "Failed",
            stdout: out.StandardOutputContent ?? "",
            stderr: out.StandardErrorContent ?? "",
          };
        }
      } catch {
        /* invocation ainda não registrada */
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return { status: "Pending", stdout: "", stderr: "timeout" };
  }

  async ssmOnline(region: string, instanceId: string): Promise<boolean> {
    const out = await this.ssmClient(region).send(
      new DescribeInstanceInformationCommand({
        Filters: [{ Key: "InstanceIds", Values: [instanceId] }],
      }),
    );
    const info = out.InstanceInformationList?.[0];
    return info?.PingStatus === "Online";
  }
}
