import { useEffect, useState } from "react";
import { api, type FakeInstance, type SeedCandidate } from "./api.ts";
import { Hint } from "./hint.tsx";

interface HostDraft {
  hostname: string;
  health_url: string;
  wake_paths: string;
}

interface DayDraft {
  on: boolean;
  start: string;
  end: string;
}

const DAYS: Array<[number, string]> = [
  [1, "segunda"],
  [2, "terça"],
  [3, "quarta"],
  [4, "quinta"],
  [5, "sexta"],
  [6, "sábado"],
  [7, "domingo"],
];

const WAKE_DEFAULT = "GET /, GET /login";

const emptyHost = (): HostDraft => ({ hostname: "", health_url: "", wake_paths: WAKE_DEFAULT });

function weekdayDraft(): Record<number, DayDraft> {
  return Object.fromEntries(DAYS.map(([weekday]) => [weekday, { on: weekday <= 5, start: "05:00", end: "18:00" }]));
}

export function CreatePage({ go, search, adapter }: { go: (href: string) => void; search: string; adapter: string }) {
  const params = new URLSearchParams(search);
  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");
  const [instanceId, setInstanceId] = useState("");
  const [region, setRegion] = useState("us-east-2");
  const [eip, setEip] = useState("");
  const [origin, setOrigin] = useState("");
  const [idle, setIdle] = useState(20);
  const [hosts, setHosts] = useState<HostDraft[]>([emptyHost()]);
  const [days, setDays] = useState<Record<number, DayDraft>>(weekdayDraft);
  const [workloads, setWorkloads] = useState<SeedCandidate["workloads"]>([]);
  const [proof, setProof] = useState("");
  const [plant, setPlant] = useState(adapter === "fake");
  const [power, setPower] = useState<"running" | "stopped">("stopped");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const candidate = params.get("candidate");
    const fake = params.get("fake");
    if (candidate) {
      void api<{ candidates: SeedCandidate[] }>("/api/seed").then((body) => {
        const found = body.candidates.find((item) => item.slug === candidate);
        if (!found) return;
        setDisplayName(found.display_name);
        setSlug(found.slug);
        setInstanceId(found.aws_instance_id ?? "");
        setRegion(found.aws_region ?? found.region_hint ?? "us-east-2");
        setEip(found.has_elastic_ip === null ? "" : found.has_elastic_ip ? "sim" : "não");
        setOrigin(found.origin_host ?? "");
        setHosts(found.hostnames.length ? found.hostnames.map((host) => ({ hostname: host.hostname, health_url: host.health_url, wake_paths: host.wake_paths.join(", ") || WAKE_DEFAULT })) : [emptyHost()]);
        setWorkloads(found.workloads);
        setProof(found.proof);
        setPlant(!found.aws_instance_id && adapter === "fake");
      });
    }
    if (fake) {
      void api<{ instances: FakeInstance[] }>("/api/dev/fake-instances").then((body) => {
        const found = body.instances.find((item) => item.instance_id === fake);
        if (!found) return;
        setSlug(found.slug ?? "");
        setDisplayName(found.slug ?? "");
        setInstanceId(found.instance_id);
        setRegion(found.region);
        setOrigin(found.public_ip ?? "");
        setEip("sim");
        setPower(found.power === "running" ? "running" : "stopped");
        setPlant(false);
        setHosts([{ hostname: `${found.slug ?? "ensaio"}.local`, health_url: `http://${found.slug ?? "ensaio"}.local/health`, wake_paths: WAKE_DEFAULT }]);
      });
    }
  }, [search, adapter]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (eip !== "sim" && eip !== "não") {
      setError("Confirme se esta EC2 tem Elastic IP.");
      return;
    }
    setSaving(true);
    try {
      if (plant) {
        await api("/api/dev/fake-instances", {
          method: "POST",
          json: {
            instance_id: instanceId,
            region,
            slug,
            power,
            public_ip: origin || null,
            systemd: ["nginx.service", `${slug}-api.service`],
          },
        });
      }
      const hostnames = hosts
        .filter((host) => host.hostname && host.health_url)
        .map((host) => ({
          hostname: host.hostname,
          health_url: host.health_url,
          wake_paths: host.wake_paths.split(",").map((item) => item.trim()).filter(Boolean),
        }));
      await api("/api/instances", {
        method: "POST",
        json: {
          display_name: displayName,
          slug,
          aws_region: region,
          aws_instance_id: instanceId,
          has_elastic_ip: eip === "sim",
          origin_host: origin || null,
          idle_minutes: idle,
          hostnames,
          schedules: DAYS.filter(([weekday]) => days[weekday]?.on).map(([weekday]) => ({
            weekday,
            start_local: days[weekday].start,
            end_local: days[weekday].end,
          })),
        },
      });
      if (workloads.length) {
        await api(`/api/instances/${slug}/workloads`, { method: "PUT", json: { workloads } });
      }
      go(`/instances/${slug}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não criou.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="top">
        <div>
          <h2>Nova EC2</h2>
          <p className="lede">O describe precisa achar a instância com as tags. A ficha já nasce em enforce, com parada autorizada, turno de segunda a sexta das 05:00 às 18:00, e abrir / ou /login liga a EC2. A parada automática espera o inventário limpo. O nome público ainda pede a nuvem laranja e a rota do Worker, como o Vortex.</p>
        </div>
      </div>
      {proof && <div className="banner">{proof}</div>}
      <form className="card" onSubmit={(event) => void submit(event)}>
        <div className="field">
          <div className="label-row">
            Tags na instância
            <Hint text="Antes de criar a ficha: EC2 → Instances → a instância → aba Tags → Manage tags. Crie shiftgate:managed = true, shiftgate:allow-stop = true, shiftgate:role = workload e shiftgate:host = o mesmo slug deste formulário. Mantenha Application, Environment = production e CostCenter = ti. Sem as quatro tags shiftgate, o cadastro responde que as tags não batem." />
          </div>
        </div>
        <div className="grid">
          <div className="field">
            <div className="label-row">Nome <Hint text="Não vem da AWS. É o nome que a frota mostra. Escolha um, por exemplo Ensaio A." /></div>
            <input aria-label="Nome" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required />
          </div>
          <div className="field">
            <div className="label-row">Slug <Hint text="EC2 → Instances → a instância → aba Tags. O valor de shiftgate:host é este slug. Só minúsculas, números e hífen, como ensaio-a. Se o slug e a tag divergirem, o describe recusa a ficha." /></div>
            <input aria-label="Slug" value={slug} onChange={(event) => setSlug(event.target.value)} required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" />
          </div>
          <div className="field">
            <div className="label-row">Instance id <Hint text="Console EC2, região Ohio. Em Instances, copie a coluna Instance ID. Começa com i- e tem 17 caracteres em seguida. A nano i-05134e5e2fa603e96 e o ERP i-0af76df96c4e714b6 ficam de fora deste ensaio." /></div>
            <input aria-label="Instance id" className="mono" value={instanceId} onChange={(event) => setInstanceId(event.target.value)} required pattern="i-[0-9a-f]{17}" />
          </div>
          <div className="field">
            <div className="label-row">Região <Hint text="Canto superior direito do console da AWS. O código desta conta é us-east-2, US East (Ohio). Digite o código, não o nome da cidade." /></div>
            <input aria-label="Região" value={region} onChange={(event) => setRegion(event.target.value)} required />
          </div>
          <div className="field">
            <div className="label-row">Elastic IP <Hint text="EC2 → menu esquerdo → Network & Security → Elastic IPs. Se a coluna Associated instance ID for esta instância, escolha sim. Se não houver endereço associado, escolha não. Sem Elastic IP o visitante não acorda a EC2." /></div>
            <select aria-label="Elastic IP" value={eip} onChange={(event) => setEip(event.target.value)} required>
              <option value="">confirmar</option>
              <option value="sim">sim</option>
              <option value="não">não</option>
            </select>
          </div>
          <div className="field">
            <div className="label-row">Origem estável <Hint text="Na mesma lista Elastic IPs, copie Allocated IPv4 address, o número do endereço. Não use o Public IPv4 da aba Details da instância: esse muda quando a máquina para. Sem Elastic IP, deixe em branco." /></div>
            <input aria-label="Origem estável" value={origin} onChange={(event) => setOrigin(event.target.value)} placeholder="Elastic IP ou hostname" />
          </div>
          <div className="field">
            <div className="label-row">Minutos de silêncio <Hint text="Não se copia da AWS. É quantos minutos sem uso, fora do turno, antes de a política considerar parar esta EC2. Duas ensaios devem ter números diferentes. 20 é um começo." /></div>
            <input aria-label="Minutos de silêncio" type="number" min={1} value={idle} onChange={(event) => setIdle(Number(event.target.value))} />
          </div>
        </div>
        <h3 className="label-row">
          Hostnames
          <Hint text="Cada linha é um nome público desta EC2. O turno continua sendo o da instância. Não cadastre aqui o hostname de uma aplicação que já está no ar até o ensaio terminar." />
        </h3>
        <div className="rowline">
          <span className="label-row">Hostname <Hint text="O nome que a pessoa digita, por exemplo ensaio-a.mundomoveis.tech. Cloudflare → mundomoveis.tech → DNS → Records. Procure esse nome na coluna Nome." /></span>
          <span className="label-row">Health <Hint text="Com a instância ligada, abra no navegador o endereço que responde quando a aplicação está boa. Quase sempre https://o-hostname/health. A URL precisa começar com http:// ou https://." /></span>
          <span className="label-row">Wake <Hint text="Abrir a raiz ou /login liga a EC2, como no Vortex. O padrão GET /, GET /login já vem preenchido. Um POST de login da aplicação entra na mesma lista, separado por vírgula." /></span>
        </div>
        <div className="rows">
          {hosts.map((host, index) => (
            <div className="rowline" key={index}>
              <input placeholder="hostname" value={host.hostname} onChange={(event) => updateHost(index, { hostname: event.target.value })} />
              <input placeholder="health url" value={host.health_url} onChange={(event) => updateHost(index, { health_url: event.target.value })} />
              <input placeholder="GET /, GET /login" value={host.wake_paths} onChange={(event) => updateHost(index, { wake_paths: event.target.value })} />
            </div>
          ))}
        </div>
        <button className="ghost" type="button" onClick={() => setHosts([...hosts, emptyHost()])}>Outro hostname</button>
        <h3 className="label-row">
          Turno
          <Hint text="Segunda a sexta, 05:00–18:00, é o turno com que o Vortex funciona. Fora dessa janela, vinte minutos sem uso desligam a EC2. Dentro dela, a visita não precisa acender a máquina: o turno já a mantém ligada." />
        </h3>
        <div className="week">
          {DAYS.map(([weekday, label]) => {
            const day = days[weekday] ?? { on: false, start: "05:00", end: "18:00" };
            return (
              <label className={day.on ? "daychip on" : "daychip"} key={weekday}>
                <span>
                  <input
                    type="checkbox"
                    aria-label={label}
                    checked={day.on}
                    onChange={(event) => setDays({ ...days, [weekday]: { ...day, on: event.target.checked } })}
                  />
                  {label}
                </span>
                <input className="time" aria-label={`${label} início`} value={day.start} onChange={(event) => setDays({ ...days, [weekday]: { ...day, start: event.target.value } })} />
                <input className="time" aria-label={`${label} fim`} value={day.end} onChange={(event) => setDays({ ...days, [weekday]: { ...day, end: event.target.value } })} />
              </label>
            );
          })}
        </div>
        {adapter === "fake" && (
          <label className="check">
            <input type="checkbox" checked={plant} onChange={(event) => setPlant(event.target.checked)} />
            Preparar tags no simulador antes do describe
          </label>
        )}
        {plant && (
          <label>
            Power inicial no simulador
            <select value={power} onChange={(event) => setPower(event.target.value as "running" | "stopped")}>
              <option value="stopped">parada</option>
              <option value="running">no ar</option>
            </select>
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <button className="solid" disabled={saving} type="submit">{saving ? "Gravando…" : "Criar ficha"}</button>
      </form>
    </>
  );

  function updateHost(index: number, patch: Partial<HostDraft>) {
    setHosts(hosts.map((host, item) => (item === index ? { ...host, ...patch } : host)));
  }
}
