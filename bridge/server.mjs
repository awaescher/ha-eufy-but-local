// eufy-but-local bridge entry point.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { CredentialStore } from "./src/credentials.mjs";
import { readConfig } from "./src/config.mjs";
import { EufyConnector } from "./src/eufy.mjs";
import { createApi } from "./src/http.mjs";
import { BridgeState } from "./src/state.mjs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const log = (tag, msg) => console.log(`${new Date().toISOString()} [${tag}] ${msg}`);

const config = readConfig();
const state = new BridgeState(version);
const credentials = new CredentialStore(config.dataDir);

let lib;
let simulator = null;
if (config.simulator) {
  const { createSimulator } = await import("./src/simulator.mjs");
  ({ lib, simulator } = createSimulator({
    tfaCode: process.env.SIM_TFA_CODE ?? "123456",
    eventIntervalSeconds: Number(process.env.SIM_EVENT_INTERVAL ?? 60),
  }));
  log("bridge", "SIMULATOR MODE – no real HomeBase involved");
} else {
  // setLoggingLevel is not exported by the package; the connector needs it to keep the
  // library's P2P debug log (per packet, with stack traces) off during livestreams.
  const require = createRequire(import.meta.url);
  const { setLoggingLevel } = require(join(dirname(require.resolve("eufy-security-client")), "logging.js"));
  lib = { ...(await import("eufy-security-client")), setLoggingLevel };
}

const connector = new EufyConnector({ state, config, lib, log });
const server = createApi({ state, connector, credentials, simulator, token: config.token, log });

server.listen(config.port, config.host, () => {
  log("bridge", `eufy-but-local bridge ${version} listening on ${config.host}:${config.port}${config.token ? " (token required)" : ""}`);
  if (!config.token) log("bridge", "WARNING: BRIDGE_TOKEN is not set – anyone on your network can use this bridge");
  const cred = config.credentials ?? credentials.load();
  if (cred) connector.start(cred);
  else log("bridge", "no credentials yet – log in through the Home Assistant integration");
});

const shutdown = async () => {
  server.close();
  await connector.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
