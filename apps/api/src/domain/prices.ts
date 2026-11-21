/** Linux sob demanda em us-east-2, hora cheia. Conferido em outubro de 2026. */
const US_EAST_2_LINUX: Record<string, number> = {
  "t4g.nano": 0.0042,
  "t3a.nano": 0.0047,
  "t3.nano": 0.0052,
  "t2.nano": 0.0058,
  "t4g.micro": 0.0084,
  "t3a.micro": 0.0094,
  "t3.micro": 0.0104,
  "t2.micro": 0.0116,
  "t4g.small": 0.0168,
  "t3a.small": 0.0188,
  "t3.small": 0.0208,
  "t2.small": 0.023,
  "t4g.medium": 0.0336,
  "t3a.medium": 0.0376,
  "t3.medium": 0.0416,
};

export const PRICE_NOTE = "Linux sob demanda em us-east-2. Disco, tráfego e IPv4 ficam de fora.";

export function linuxHourlyUsd(region: string, instanceType: string | null): number | null {
  if (region !== "us-east-2" || !instanceType) return null;
  return US_EAST_2_LINUX[instanceType] ?? null;
}
