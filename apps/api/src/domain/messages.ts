export const STOP_MESSAGE: Record<string, string> = {
  in_shift: "A EC2 está no turno. A automação não desliga.",
  idle_not_met: "Ainda há uso dentro da janela de silêncio desta EC2.",
  min_runtime: "O tempo mínimo ligada, depois do health, ainda não passou.",
  unregistered_service: "Há serviço fora do cadastro nesta EC2. StopInstances não saiu.",
  observe_only: "Automação em observação. A chamada à AWS não saiu.",
  clock_skew: "Relógio com desvio acima de 30 s. Ninguém para.",
  control_plane_protected: "Esta instância é o plano de controle.",
  inactive: "O registro está desativado.",
  stop_disabled: "Parar esta EC2 ainda não foi autorizado.",
  hold_on: "Há um override para manter esta EC2 ligada.",
  quiesce_open: "A janela de quiesce ainda está aberta.",
  conflict_phase: "A fase atual não aceita essa transição.",
  min_off: "A EC2 acabou de desligar. A partida automática de turno espera.",
  cooldown: "Falha recente. A automação ainda está em espera.",
  sticky_error: "A quarta falha deixa a EC2 em erro até uma pessoa agir.",
  wake_budget: "O orçamento de 3 partidas automáticas nesta hora já foi usado.",
  no_eip: "Sem Elastic IP o wake não usa este endereço.",
  tag_mismatch: "As tags da instância não fecham com o cadastro.",
  lock_held: "Outra operação desta EC2 está com o lock.",
};

export function stopMessage(code: string): string {
  return STOP_MESSAGE[code] ?? "A política não deixou a chamada sair.";
}

const PUBLIC = new Set([
  "in_shift",
  "unregistered_service",
  "observe_only",
  "clock_skew",
  "control_plane_protected",
  "inactive",
  "tag_mismatch",
  "conflict_phase",
  "cooldown",
  "wake_budget",
  "validation",
  "not_found",
  "forbidden",
  "lock_held",
]);

export function publicCode(internal: string): string {
  return PUBLIC.has(internal) ? internal : "conflict_phase";
}
