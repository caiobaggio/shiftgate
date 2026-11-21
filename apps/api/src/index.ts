import { loadConfig } from "./config.ts";
import { buildApp } from "./http/app.ts";

const config = loadConfig();
const app = await buildApp({ config, ticker: true });
await app.listen({ port: config.port, host: "0.0.0.0" });
console.log(`Shiftgate em http://127.0.0.1:${config.port}`);
