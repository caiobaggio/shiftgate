import { useEffect, useState } from "react";
import { PHASE_LABEL, POWER_LABEL, type InstanceDetail } from "../../../packages/contracts/src/index.ts";
import { api, reasonHeader } from "./api.ts";
import { Hint } from "./hint.tsx";

function calmGate(code: string | null): boolean {
  return code === null || code === "in_shift" || code === "idle_not_met" || code === "min_runtime" || code === "hold_on";
}

const DAYS: Array<[number, string, string]> = [
  [1, "segunda", "seg"],
  [2, "terça", "ter"],
  [3, "quarta", "qua"],
  [4, "quinta", "qui"],
  [5, "sexta", "sex"],
  [6, "sábado", "sáb"],
  [7, "domingo", "dom"],
];

const ACTION_LABEL: Record<string, string> = {
  observe_skipped: "Comando não saiu",
  stop_requested: "Parada pedida",
  start_requested: "Partida pedida",
  ssm_called: "Leitura SSM",
  schedule_upsert: "Turno gravado",
  phase_changed: "Fase mudou",
  register_instance: "Ficha criada",
  unregistered_service: "Discover bloqueou",
  idle_updated: "Silêncio gravado",
  aws_stop_called: "StopInstances",
  aws_start_called: "StartInstances",
  override_set: "Override gravado",
};

function stopReasons(detail: InstanceDetail): string[] {
  const reasons: string[] = [];
  if (!detail.active) reasons.push("A ficha está desativada. A AWS não é chamada.");
  if (detail.automation !== "enforce") reasons.push("Observação. Parar registra a intenção e não chama a AWS.");
  if (detail.phase === "schedule_hold" || detail.stop_gate.code === "in_shift") {
    reasons.push(`No turno (${detail.schedule_summary}). A janela segura a instância.`);
  }
  if (!detail.instance_stop_enabled) reasons.push("O stop desta EC2 ainda não foi autorizado.");
  if (detail.block_instance_stop) reasons.push(detail.block_reason || "O discover ainda bloqueia o stop.");
  return reasons;
}

function startReasons(detail: InstanceDetail): string[] {
  const reasons: string[] = [];
  if (!detail.active) reasons.push("A ficha está desativada.");
  if (detail.automation !== "enforce") reasons.push("Observação. Ligar não chama a AWS.");
  if (detail.power === "running" || detail.power === "blocked") reasons.push("A instância já está no ar.");
  return reasons;
}

function punchNote(detail: InstanceDetail, canAdmin: boolean, inShift: boolean): string {
  if (!detail.active) return "A ficha está desativada.";
  if (detail.automation !== "enforce") return "Em observação o override não chama a AWS.";
  if (!detail.instance_stop_enabled) return "O stop desta EC2 ainda não foi autorizado.";
  if (detail.block_instance_stop) return detail.block_reason || "O discover ainda bloqueia o stop.";
  if (!canAdmin) return "Só um admin fura a janela.";
  if (!inShift) return "Fora do turno, o comando Parar já cobre a parada.";
  return "Isto grava um override para parar dentro da janela.";
}

function toneOf(kind: "ok" | "hold" | "bad" | "idle"): string {
  return kind;
}

export function DetailPage({ slug, go, role, adapter }: { slug: string; go: (href: string) => void; role: string; adapter: string }) {
  const [detail, setDetail] = useState<InstanceDetail | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [idle, setIdle] = useState(20);
  const [days, setDays] = useState<Record<number, { on: boolean; start: string; end: string }>>({});
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState("");
  const [hold, setHold] = useState(30);
  const [events, setEvents] = useState<Array<{ id: string; at: string; action: string; reason: string | null; from_phase: string | null; to_phase: string | null }>>([]);
  const canAdmin = role === "admin";
  const canOperate = role === "admin" || role === "operator";

  async function load(resetForms: boolean) {
    const body = await api<InstanceDetail>(`/api/instances/${slug}`);
    setDetail(body);
    if (resetForms) {
      setIdle(body.idle_minutes);
      const next: typeof days = {};
      for (const [weekday] of DAYS) {
        const found = body.windows.find((window) => window.weekday === weekday);
        next[weekday] = { on: Boolean(found), start: found?.start_local ?? "05:00", end: found?.end_local ?? "18:00" };
      }
      setDays(next);
    }
    const history = await api<{ events: typeof events }>(`/api/instances/${slug}/events?limit=12`);
    setEvents(history.events);
  }

  useEffect(() => {
    void load(true).catch((caught) => setError(caught instanceof Error ? caught.message : "Não abriu."));
    const timer = setInterval(() => {
      void load(false).catch(() => undefined);
    }, 8000);
    return () => clearInterval(timer);
  }, [slug]);

  async function run(action: () => Promise<unknown>, ok: string) {
    setError("");
    setInfo("");
    try {
      await action();
      setInfo(ok);
      await load(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falhou.");
    }
  }

  function confirmed(): string | null {
    if (reason.trim().length < 12) return "O motivo precisa de pelo menos 12 caracteres.";
    if (confirm !== slug) return "Redigite o slug desta EC2 para confirmar.";
    return null;
  }

  if (!detail) return <p>{error || "Abrindo a ficha…"}</p>;

  const stops = stopReasons(detail);
  const starts = startReasons(detail);
  const inShift = detail.phase === "schedule_hold" || detail.stop_gate.code === "in_shift";
  const canPunch = canAdmin && detail.automation === "enforce" && detail.instance_stop_enabled && !detail.block_instance_stop && detail.active && inShift;
  const powerTone = detail.power === "running" ? "ok" : detail.power === "blocked" || detail.power === "error" ? "bad" : detail.power === "stopped" ? "idle" : "hold";
  const phaseTone = detail.phase === "schedule_hold" ? "ok" : detail.phase === "error" ? "bad" : detail.phase === "on" ? "hold" : "idle";
  const modeTone = !detail.active ? "bad" : detail.automation === "enforce" ? "ok" : "hold";
  const gateTone = calmGate(detail.stop_gate.code) ? "ok" : "bad";

  return (
    <>
      <div className="top">
        <div>
          <h2>{detail.display_name}</h2>
          <p className="mono">{detail.aws_instance_id} · {detail.aws_region} · {detail.slug}</p>
        </div>
        <button className="ghost" onClick={() => go("/")}>Frota</button>
      </div>

      <section className="gauges" aria-label="Estado da EC2">
        <article className="gauge" data-tone={toneOf(powerTone)}>
          <span className="kicker">Energia</span>
          <strong>{POWER_LABEL[detail.power]}</strong>
          <p>{detail.has_elastic_ip ? `EIP ${detail.origin_host || "associado"}` : "Sem Elastic IP"}</p>
          <i className="lamp" />
        </article>
        <article className="gauge" data-tone={toneOf(phaseTone)}>
          <span className="kicker">Fase</span>
          <strong>{PHASE_LABEL[detail.phase]}</strong>
          <p>{detail.schedule_summary}</p>
          <i className="lamp" />
        </article>
        <article className="gauge" data-tone={toneOf(modeTone)}>
          <span className="kicker">Modo</span>
          <strong>{detail.active ? (detail.automation === "observe" ? "Observação" : "Enforce") : "Desativada"}</strong>
          <p>{detail.instance_stop_enabled ? "Stop autorizado" : "Stop fechado"}</p>
          <i className="lamp" />
        </article>
        <article className="gauge" data-tone={toneOf(gateTone)}>
          <span className="kicker">Portão</span>
          <strong>{calmGate(detail.stop_gate.code) ? "Segurando" : "Atenção"}</strong>
          <p>{detail.stop_gate.message}</p>
          <i className="lamp" />
        </article>
      </section>

      {detail.intention && <div className="banner">Em observação, o próximo tick faria: {detail.intention === "start" ? "StartInstances" : "StopInstances"}.</div>}
      {detail.block_reason && <div className="banner warn">{detail.block_reason}</div>}
      {info && <div className="banner ok">{info}</div>}
      {error && <div className="banner warn">{error}</div>}

      {canOperate && (
        <section className="console">
          <div className="command">
            <h3>Comando</h3>
            <div className="command-buttons">
              <button
                className="command-go"
                disabled={starts.length > 0}
                onClick={() => void run(() => api(`/api/instances/${slug}/start`, { method: "POST", json: {} }), "Partida pedida.")}
              >
                Ligar
              </button>
              <button
                className="command-stop"
                disabled={stops.length > 0}
                onClick={() => {
                  const problem = confirmed();
                  if (problem) {
                    setError(problem);
                    return;
                  }
                  void run(() => api(`/api/instances/${slug}/stop`, {
                    method: "POST",
                    headers: reasonHeader(reason),
                    json: { reason, confirm_slug: confirm },
                  }), "Parada pedida.");
                }}
              >
                Parar
              </button>
            </div>
            {(stops.length > 0 || starts.some((item) => item === "A instância já está no ar.")) && (
              <ul className="reasons">
                {stops.map((item) => <li key={item}>{item}</li>)}
                {starts.includes("A instância já está no ar.") && <li>A instância já está no ar.</li>}
              </ul>
            )}
            {stops.length === 0 && <p className="lede">Parar pede o motivo e o slug. A chamada só sai com enforce, fora do turno, stop autorizado e discover limpo.</p>}
            <div className="grid" style={{ marginTop: "0.8rem" }}>
              <label>Motivo <Hint text="Texto de pelo menos 12 caracteres. Fica no evento da ficha. Exemplo: ensaio de parada fora do turno." /><input aria-label="Motivo" value={reason} onChange={(event) => setReason(event.target.value)} /></label>
              <label>Slug redigitado <Hint text="Digite o slug da ficha, igual ao da URL, para confirmar que o comando é desta EC2." /><input aria-label="Slug redigitado" value={confirm} onChange={(event) => setConfirm(event.target.value)} placeholder={slug} /></label>
            </div>
          </div>
          <div className="command">
            <h3 className="label-row">Furar o turno <Hint text="Override de admin. Segura a decisão de parar pelo número de minutos, mesmo dentro da janela. Em observação o override não chama a AWS." /></h3>
            <p className="lede">{punchNote(detail, canAdmin, inShift)}</p>
            <label>Minutos <input aria-label="Minutos do override" type="number" min={1} value={hold} onChange={(event) => setHold(Number(event.target.value))} /></label>
            <div className="actions" style={{ marginTop: "0.7rem" }}>
              <button
                className="ghost"
                disabled={!canPunch}
                onClick={() => {
                  const problem = confirmed();
                  if (problem) {
                    setError(problem);
                    return;
                  }
                  void run(() => api(`/api/instances/${slug}/stop`, {
                    method: "POST",
                    headers: reasonHeader(reason),
                    json: { reason, confirm_slug: confirm, hold_minutes: hold },
                  }), "Override de parada gravado.");
                }}
              >
                Parar mesmo no turno
              </button>
              <button
                className="ghost"
                disabled={detail.automation !== "enforce" || !detail.active}
                onClick={() => {
                  const problem = confirmed();
                  if (problem) {
                    setError(problem);
                    return;
                  }
                  void run(() => api(`/api/instances/${slug}/start`, {
                    method: "POST",
                    headers: reasonHeader(reason),
                    json: { reason, hold_minutes: hold, confirm_slug: confirm },
                  }), "Partida com espera gravada.");
                }}
              >
                Ligar e segurar
              </button>
            </div>
          </div>
        </section>
      )}

      <div className="panels">
        <section className="card">
          <h3 className="label-row">Turno <Hint text="Dias e horário de São Paulo. O fim é exclusivo: 18:00 já está fora. 00:00 até 00:00 no mesmo dia é o dia inteiro." /></h3>
          <div className="week">
            {DAYS.map(([weekday, label, short]) => {
              const on = days[weekday]?.on ?? false;
              return (
                <label className={on ? "daychip on" : "daychip"} key={weekday}>
                  <span className="daychip-name">
                    <input
                      type="checkbox"
                      checked={on}
                      aria-label={label}
                      onChange={(event) => setDays({ ...days, [weekday]: { ...days[weekday], on: event.target.checked } })}
                    />
                    {short}
                  </span>
                  <input className="time" aria-label={`${label} início`} value={days[weekday]?.start ?? "05:00"} onChange={(event) => setDays({ ...days, [weekday]: { ...days[weekday], start: event.target.value } })} />
                  <input className="time" aria-label={`${label} fim`} value={days[weekday]?.end ?? "18:00"} onChange={(event) => setDays({ ...days, [weekday]: { ...days[weekday], end: event.target.value } })} />
                </label>
              );
            })}
          </div>
          {canAdmin && (
            <button
              className="solid"
              style={{ marginTop: "0.8rem" }}
              onClick={() => void run(() => api(`/api/instances/${slug}/schedules`, {
                method: "PUT",
                json: {
                  timezone: detail.timezone,
                  windows: DAYS.filter(([weekday]) => days[weekday]?.on).map(([weekday]) => ({
                    weekday,
                    start_local: days[weekday].start,
                    end_local: days[weekday].end,
                  })),
                },
              }), "Turno gravado.")}
            >
              Gravar turno
            </button>
          )}
        </section>

        <section className="card">
          <h3 className="label-row">Silêncio <Hint text="Minutos sem uso, fora do turno, antes de a política considerar parar. Não se lê na AWS." /></h3>
          <p className="silence-figure">{idle}<small> min</small></p>
          <label>
            Minutos sem uso fora do turno
            <input aria-label="Minutos de silêncio" type="number" min={1} value={idle} onChange={(event) => setIdle(Number(event.target.value))} />
          </label>
          {canAdmin && <button className="solid" style={{ marginTop: "0.8rem" }} onClick={() => void run(() => api(`/api/instances/${slug}/idle`, { method: "PUT", json: { idle_minutes: idle } }), "Minutos gravados.")}>Gravar minutos</button>}
          {detail.override && <p className="lede">Override {detail.override.hold} até {detail.override.expires_at.slice(0, 16)}. {detail.override.reason}</p>}
        </section>
      </div>

      <div className="panels">
        <section className="card">
          <h3>Hostnames</h3>
          {detail.hostnames.length === 0 && <p className="lede">Nenhum hostname. O wake não tem porta.</p>}
          <ul className="inventory">
            {detail.hostnames.map((host) => (
              <li key={host.hostname}>
                <i className="lamp" data-on={host.last_health_ok ? "yes" : "no"} />
                <div>
                  <span className="mono">{host.hostname}</span>
                  <div className="mono">{host.wake_paths.join(", ") || "allowlist vazia"}</div>
                  {adapter === "fake" && <a href={`/dev/ligar?host=${host.hostname}`}>simular acesso</a>}
                </div>
                <span>{host.last_health_ok ? "health ok" : "health pendente"}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="card">
          <h3>Workloads</h3>
          <p className="lede">{detail.discover?.clean ? "Discover limpo." : "Inventário do discover. Processos sem turno."}</p>
          {detail.workloads.length === 0 && <p>Nenhum processo cadastrado.</p>}
          <ul className="inventory">
            {detail.workloads.map((workload) => (
              <li key={workload.slug}>
                <i className="lamp" data-on="yes" />
                <div>
                  <strong>{workload.display_name}</strong>
                  <div className="mono">{workload.unit_name}</div>
                </div>
                <span>{workload.runtime}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {canAdmin && (
        <section className="card">
          <h3>Política</h3>
          <div className="toggles">
            <div className="toggle">
              <div>
                <strong>{detail.automation === "observe" ? "Observação" : "Enforce"}</strong>
                <p>A primeira semana fica em observação. Enforce é que chama a AWS.</p>
              </div>
              <button className="ghost" onClick={() => void run(() => api(`/api/instances/${slug}/policy`, { method: "PUT", json: { automation: detail.automation === "observe" ? "enforce" : "observe" } }), "Automação alterada.")}>
                {detail.automation === "observe" ? "Passar a enforce" : "Voltar a observação"}
              </button>
            </div>
            <div className="toggle">
              <div>
                <strong>{detail.instance_stop_enabled ? "Stop autorizado" : "Stop fechado"}</strong>
                <p>Sem esta autorização, a política e o botão não chamam StopInstances.</p>
              </div>
              <button className="ghost" onClick={() => void run(() => api(`/api/instances/${slug}/policy`, { method: "PUT", json: { instance_stop_enabled: !detail.instance_stop_enabled } }), "Autorização de stop alterada.")}>
                {detail.instance_stop_enabled ? "Revogar stop" : "Autorizar stop"}
              </button>
            </div>
            <div className="toggle">
              <div>
                <strong>{detail.discover?.clean ? "Inventário limpo" : "Inventário"}</strong>
                <p>{detail.discover?.at ? `Última leitura ${detail.discover.at.slice(0, 16)}` : "Ainda sem discover."}</p>
              </div>
              <button className="ghost" onClick={() => void run(() => api(`/api/instances/${slug}/discover`, { method: "POST" }), "Discover atualizado.")}>Ler de novo</button>
            </div>
            <div className="toggle">
              <div>
                <strong>{detail.active ? "Ficha ativa" : "Ficha desativada"}</strong>
                <p>Desativar tira a EC2 do tick. A instância não é parada.</p>
              </div>
              <button className="danger" onClick={() => void run(() => api(`/api/instances/${slug}/${detail.active ? "deactivate" : "activate"}`, {
                method: "POST",
                headers: detail.active ? reasonHeader("desativar sem parar a instância") : undefined,
                json: detail.active ? { reason: "desativar sem parar a instância" } : {},
              }), detail.active ? "Desativada. A AWS não foi chamada." : "Reativada.")}>
                {detail.active ? "Desativar" : "Reativar"}
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="card">
        <h3>Eventos</h3>
        <ul className="events">
          {events.map((event) => (
            <li key={event.id}>
              <span className="mono">{event.at.slice(0, 19)}</span>
              <span>{ACTION_LABEL[event.action] ?? event.action}</span>
              <span>{event.reason ?? ""} {event.from_phase && event.to_phase ? `${event.from_phase} → ${event.to_phase}` : ""}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
