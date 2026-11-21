export function renderWait(message: string, deadline: string | undefined, requestId: string): string {
  return page({ title: "Ligando", message, deadline, token: requestId, alive: true, poll: Boolean(deadline) });
}

export function renderRetry(message: string): string {
  return page({ title: "Ligando", message, alive: true, reload: true });
}

export function renderClosed(message: string): string {
  return page({ title: "Fechado", message });
}

export function renderFailed(message: string, eventId?: string): string {
  return page({ title: "Não foi possível ligar", message, token: eventId ?? "", failed: true });
}

function page(options: {
  title: string;
  message: string;
  deadline?: string;
  token?: string;
  failed?: boolean;
  alive?: boolean;
  poll?: boolean;
  reload?: boolean;
}): string {
  const title = escapeHtml(options.title);
  const message = escapeHtml(options.message);
  const token = escapeHtml(options.token ?? "");
  const alive = Boolean(options.alive);
  return `<!doctype html>
<html lang="pt-BR">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #14160f; color: #f3efe4; font-family: "Segoe UI", sans-serif; }
  main { width: min(34rem, calc(100% - 2rem)); }
  .mark { letter-spacing: .16em; text-transform: uppercase; font-size: .72rem; color: #e0a34a; }
  h1 { font-family: Palatino, Georgia, serif; font-weight: 500; font-size: 2.4rem; margin: .3rem 0; }
  p { color: #c9c2b2; line-height: 1.5; }
  .spinner { width: 3.2rem; height: 3.2rem; margin: 1.2rem 0 0.4rem; border-radius: 50%; border: 3px solid #30362a; border-top-color: ${options.failed ? "#d67060" : "#e0a34a"}; ${alive ? "animation: spin .8s linear infinite;" : ""} }
  .bar { height: 3px; background: #30362a; margin: 1.2rem 0; overflow: hidden; }
  .bar span { display: block; height: 100%; width: 35%; background: ${options.failed ? "#d67060" : "#e0a34a"}; ${alive ? "animation: slide 1.2s ease-in-out infinite;" : ""} }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes slide { 0% { transform: translateX(-120%); } 100% { transform: translateX(320%); } }
</style>
<main>
  <p class="mark">Shiftgate</p>
  <h1 id="title">${title}</h1>
  ${alive ? `<div class="spinner" role="img" aria-label="Carregando"></div>` : ""}
  <div class="bar"><span></span></div>
  <p id="msg">${message}</p>
  <p id="left"></p>
  ${token ? `<p>Referência ${token}</p>` : ""}
</main>
${script(options)}
</html>`;
}

function script(options: { deadline?: string; token?: string; poll?: boolean; reload?: boolean }): string {
  if (options.poll && options.deadline && options.token) {
    return `<script>
      const deadline = ${JSON.stringify(options.deadline)};
      const requestId = ${JSON.stringify(options.token)};
      const left = document.getElementById("left");
      async function poll() {
        try {
          const response = await fetch("/__shiftgate/status?request_id=" + encodeURIComponent(requestId), { cache: "no-store" });
          const body = await response.json();
          if (body.decision === "proxy") { location.reload(); return; }
          const title = document.getElementById("title");
          const msg = document.getElementById("msg");
          if (body.decision === "failed" || body.decision === "closed") {
            if (title) title.textContent = body.decision === "failed" ? "Não foi possível ligar" : "Fechado";
            if (msg && body.message) msg.textContent = body.message;
            return;
          }
          if (title) title.textContent = "Ligando";
          if (msg && body.message) msg.textContent = body.message;
          setTimeout(poll, (body.retry_after_sec || 5) * 1000);
        } catch {
          setTimeout(poll, 5000);
        }
      }
      function tick() {
        const remain = Math.max(0, Math.round((new Date(deadline).getTime() - Date.now()) / 1000));
        if (left) left.textContent = remain + " s dentro do teto.";
      }
      tick();
      setInterval(tick, 1000);
      setTimeout(poll, 5000);
    </script>`;
  }
  if (options.reload) {
    return `<script>setTimeout(() => location.reload(), 5000);</script>`;
  }
  return "";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}
