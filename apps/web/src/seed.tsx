import { useEffect, useState } from "react";
import { api, type FakeInstance, type SeedCandidate } from "./api.ts";

export function SeedPage({ go }: { go: (href: string) => void }) {
  const [candidates, setCandidates] = useState<SeedCandidate[]>([]);
  const [note, setNote] = useState("");
  const [fake, setFake] = useState<FakeInstance[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    void api<{ note?: string; candidates: SeedCandidate[] }>("/api/seed")
      .then((body) => {
        setCandidates(body.candidates);
        setNote(body.note ?? "");
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Sem semente."));
    void api<{ instances: FakeInstance[] }>("/api/dev/fake-instances")
      .then((body) => setFake(body.instances))
      .catch(() => setFake([]));
  }, []);

  return (
    <>
      <div className="top">
        <div>
          <h2>Semente</h2>
          <p className="lede">{note || "O que o disco deixa importar. O describe, na hora do cadastro, junta ou separa."}</p>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {fake.length > 0 && (
        <section className="card">
          <h3>Simulador local</h3>
          <p className="lede">Estas caixas existem só na memória do processo. Não são a conta AWS. Servem para ensaiar duas fichas com turnos diferentes.</p>
          <table className="board">
            <thead>
              <tr><th>Slug</th><th>Instance id</th><th>Power</th><th></th></tr>
            </thead>
            <tbody>
              {fake.map((box) => (
                <tr key={box.instance_id}>
                  <td>{box.slug}</td>
                  <td className="mono">{box.instance_id}</td>
                  <td>{box.power}</td>
                  <td><button className="ghost" onClick={() => go(`/nova?fake=${box.instance_id}`)}>Cadastrar</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <table className="board">
        <thead>
          <tr><th>Candidata</th><th>Prova</th><th>Endereço no arquivo</th><th></th></tr>
        </thead>
        <tbody>
          {candidates.map((candidate) => (
            <tr key={candidate.slug}>
              <td>
                <strong>{candidate.display_name}</strong>
                <div className="mono">{candidate.slug}</div>
                <div className="mono">{candidate.aws_instance_id ?? "instance id em branco"}</div>
              </td>
              <td>{candidate.proof}</td>
              <td className="mono">{candidate.address_in_file ?? "—"}</td>
              <td>
                {candidate.registered ? "já cadastrada" : <button className="ghost" onClick={() => go(`/nova?candidate=${candidate.slug}`)}>Conferir</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
