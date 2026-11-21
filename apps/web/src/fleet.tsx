import { useEffect, useState } from "react";
import { PHASE_LABEL, POWER_LABEL } from "../../../packages/contracts/src/index.ts";
import { api, type InstanceSummary } from "./api.ts";

export function FleetPage({ go }: { go: (href: string) => void }) {
  const [rows, setRows] = useState<InstanceSummary[]>([]);
  const [error, setError] = useState("");

  async function load() {
    try {
      const body = await api<{ instances: InstanceSummary[] }>("/api/instances");
      setRows(body.instances);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao listar.");
    }
  }

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <>
      <div className="top">
        <div>
          <h2>Frota</h2>
          <p className="lede">Cada linha é uma EC2. O turno e os minutos de silêncio são dela. As aplicações nessa máquina compartilham o relógio e não têm turno próprio.</p>
        </div>
        <button className="solid" onClick={() => go("/nova")}>Nova EC2</button>
      </div>
      {error && <p className="error">{error}</p>}
      {rows.length === 0 ? (
        <div className="empty">
          <p>Nenhuma EC2 cadastrada. A semente do disco não entra sozinha.</p>
          <button className="ghost" onClick={() => go("/semente")}>Ver a semente</button>
        </div>
      ) : (
        <table className="board">
          <thead>
            <tr>
              <th>Nome</th>
              <th>Instance id</th>
              <th>Região</th>
              <th>Power</th>
              <th>Fase</th>
              <th>Turno</th>
              <th>Idle</th>
              <th>EIP</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.slug} onClick={() => go(`/instances/${row.slug}`)} style={{ cursor: "pointer" }}>
                <td>
                  <strong>{row.display_name}</strong>
                  <div className="mono">{row.slug}</div>
                  {row.intention && <div>faria: {row.intention === "start" ? "ligar" : "parar"}</div>}
                </td>
                <td className="mono">{row.aws_instance_id}</td>
                <td className="mono">{row.aws_region}</td>
                <td><span className="stamp" data-power={row.power}><i />{POWER_LABEL[row.power]}</span></td>
                <td><span className="stamp" data-phase={row.phase}><i />{PHASE_LABEL[row.phase]}</span></td>
                <td>{row.schedule_summary}</td>
                <td>{row.idle_minutes} min</td>
                <td>{row.has_elastic_ip ? "sim" : "não"}</td>
                <td>{row.active ? row.automation : "desativada"}{row.block_instance_stop ? " · bloqueio" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
