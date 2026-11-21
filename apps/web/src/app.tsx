import { useEffect, useState } from "react";
import { api, type Health, type Me } from "./api.ts";
import { CreatePage } from "./create.tsx";
import { DetailPage } from "./detail.tsx";
import { FleetPage } from "./fleet.tsx";
import { SavingsPage } from "./savings.tsx";
import { SeedPage } from "./seed.tsx";

function useRoute() {
  const [path, setPath] = useState(window.location.pathname + window.location.search);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname + window.location.search);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  function go(href: string) {
    window.history.pushState({}, "", href);
    setPath(window.location.pathname + window.location.search);
  }
  return { path, go };
}

export function App() {
  const { path, go } = useRoute();
  const [me, setMe] = useState<Me | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [ready, setReady] = useState(false);
  const [railClosed, setRailClosed] = useState(storedRailClosed);

  useEffect(() => {
    void api<Health>("/api/health").then(setHealth).catch(() => setHealth(null));
    void api<Me>("/api/me")
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setReady(true));
  }, []);

  function toggleRail() {
    setRailClosed((current) => {
      const next = !current;
      try {
        localStorage.setItem("shiftgate-rail", next ? "closed" : "open");
      } catch {
        /* a preferência fica só nesta visita */
      }
      return next;
    });
  }

  if (!ready) return <p className="login">Abrindo o turno…</p>;
  if (!me) return <Login health={health} onIn={setMe} />;

  const pathname = path.split("?")[0] || "/";
  const current = pathname.startsWith("/instances/") ? "detail" : pathname === "/nova" ? "nova" : pathname === "/semente" ? "semente" : pathname === "/acompanhamento" ? "acompanhamento" : "frota";

  return (
    <div className="shell" data-rail={railClosed ? "closed" : "open"}>
      <aside className="rail">
        <div className="brand">
          <div className="gate" aria-hidden="true" />
          <div className="brand-copy">
            <h1>Shiftgate</h1>
            <p>Turno das EC2</p>
          </div>
          <button type="button" className="rail-toggle" aria-expanded={!railClosed} aria-label={railClosed ? "Abrir a barra lateral" : "Recolher a barra lateral"} onClick={toggleRail}>
            {railClosed ? "›" : "‹"}
          </button>
        </div>
        <nav>
          <a href="/" title="Frota" aria-label="Frota" aria-current={current === "frota" ? "page" : undefined} onClick={(event) => { event.preventDefault(); go("/"); }}><span className="mark">F</span><span className="nav-label">Frota</span></a>
          <a href="/acompanhamento" title="Acompanhamento" aria-label="Acompanhamento" aria-current={current === "acompanhamento" ? "page" : undefined} onClick={(event) => { event.preventDefault(); go("/acompanhamento"); }}><span className="mark">A</span><span className="nav-label">Acompanhamento</span></a>
          <a href="/nova" title="Nova EC2" aria-label="Nova EC2" aria-current={current === "nova" ? "page" : undefined} onClick={(event) => { event.preventDefault(); go("/nova"); }}><span className="mark">N</span><span className="nav-label">Nova EC2</span></a>
          <a href="/semente" title="Semente" aria-label="Semente" aria-current={current === "semente" ? "page" : undefined} onClick={(event) => { event.preventDefault(); go("/semente"); }}><span className="mark">S</span><span className="nav-label">Semente</span></a>
        </nav>
        <div className="foot">
          <div className="who">{me.email}</div>
          <div className="who">{me.role} · {health?.adapter === "fake" ? "simulador" : "AWS"}</div>
          <button className="nav" title="Sair" onClick={() => void api("/api/session", { method: "DELETE" }).then(() => setMe(null))}>Sair</button>
        </div>
      </aside>
      <main>
        {current === "frota" && <FleetPage go={go} />}
        {current === "acompanhamento" && <SavingsPage />}
        {current === "nova" && <CreatePage go={go} search={path.split("?")[1] ?? ""} adapter={health?.adapter ?? "fake"} />}
        {current === "semente" && <SeedPage go={go} />}
        {current === "detail" && <DetailPage slug={decodeURIComponent(pathname.slice("/instances/".length))} go={go} role={me.role} adapter={health?.adapter ?? "fake"} />}
      </main>
    </div>
  );
}

function storedRailClosed(): boolean {
  try {
    return localStorage.getItem("shiftgate-rail") === "closed";
  } catch {
    return false;
  }
}

function Login({ health, onIn }: { health: Health | null; onIn: (me: Me) => void }) {
  const [email, setEmail] = useState("admin@shiftgate.local");
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await api("/api/session", { method: "POST", json: { email } });
      onIn(await api<Me>("/api/me"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não entrou.");
    }
  }
  return (
    <div className="login">
      <form className="card" onSubmit={(event) => void submit(event)}>
        <div className="brand">
          <div className="gate" aria-hidden="true" />
          <div>
            <h1>Shiftgate</h1>
            <p>O portão do turno de cada EC2</p>
          </div>
        </div>
        {health?.dev_auth ? (
          <>
            <p className="lede">No laboratório, entre com o e-mail de um operador. Em produção a sessão nasce do Cloudflare Access.</p>
            <label>
              E-mail
              <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" required />
            </label>
            {error && <p className="error">{error}</p>}
            <button className="solid" type="submit">Entrar</button>
          </>
        ) : (
          <p>Entre pelo Cloudflare Access. A API só abre sessão para um operador cadastrado.</p>
        )}
      </form>
    </div>
  );
}
