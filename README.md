# Shiftgate

Painel que pilota as EC2 uma a uma. O turno, o silêncio e o `StopInstances` são da instância, não da aplicação. O hostname é só a porta: a borda acha a EC2 dona daquele `Host` e aplica o relógio dela.

O nome vem do portão do turno. A pasta do repositório é `shiftgate`.

O desenho completo está em [docs/playbook-painel-ec2.md](docs/playbook-painel-ec2.md). Este processo não altera os repositórios da raiz MM.

## Rodar aqui

```text
npm install
npm test
npm run dev
```

O painel abre em `http://localhost:5173`. No simulador, entre com `admin@shiftgate.local`. A API escuta em `http://127.0.0.1:8080` com `AWS_ADAPTER=fake`: describe, start e stop ficam em memória, a partir de `seed/fake-cloud.json`.

A semente em `seed/mm-root.seed.json` não vira cadastro sozinha. Na tela Semente, um admin confirma instance id, região, Elastic IP e hostnames. Criar uma ficha que não estava na semente é a mesma tela.

Duas caixas de ensaio já estão no simulador: `ensaio-a` (`i-0aaaaaaa000000001`, no ar) e `ensaio-b` (`i-0bbbbbbb000000002`, parada). Elas não são a conta AWS.

## Produção do nano

Um processo Node 22 ou 24, usuário `shiftgate` sem sudo, SQLite em `/var/lib/shiftgate`. A unit está em `infra/systemd/shiftgate.service`. O papel IAM está em `infra/iam/shiftgate-role.json` (troque `ACCOUNT`). O documento SSM `shiftgate-service-control` só aceita `start`, `stop` ou `status` e um slug que casa com `/etc/shiftgate/apps/<slug>.env`.

Não há `AWS_ACCESS_KEY_ID`. O processo usa o instance profile. A nano leva a tag `shiftgate:role=control-plane` e o id dela entra em `CONTROL_PLANE_INSTANCE_ID`. O papel nega start, stop e SSM nela.

`DEV_AUTH` fica desligado. A sessão nasce do `Cf-Access-Jwt-Assertion`, e o `subject` precisa existir em `operators`. A primeira semana de cada EC2 real permanece em `automation=observe`. `instance_stop_enabled` só depois de um discover limpo. O ERP `i-0af76df96c4e714b6` não é instância de ensaio.

O Worker em `apps/edge` não contém hostname nem instance id. O `Host` do pedido é a chave. `EDGE_SHARED_SECRET` vai por `wrangler secret put`.

Variáveis em `.env.example`. Backup horário: `infra/systemd/shiftgate-backup.timer`.
