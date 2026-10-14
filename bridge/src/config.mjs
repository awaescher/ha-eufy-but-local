// Runtime configuration from environment variables.

const int = (value, fallback, name) => {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid value for ${name}: ${value}`);
  return n;
};

export function readConfig(env = process.env) {
  return {
    host: env.BRIDGE_HOST || "0.0.0.0",
    port: int(env.BRIDGE_PORT, 3080, "BRIDGE_PORT"),
    token: env.BRIDGE_TOKEN || "",
    dataDir: env.DATA_DIR || "./data",
    // Event database poll (P2P, local, wakes no camera). A recording showed up in Home
    // Assistant about 7 s after walking past a camera (2026-10-15); polling adds half of this.
    pollSeconds: int(env.POLL_SEC, 2, "POLL_SEC"),
    // Asks the HomeBase for the current camera settings (P2P, local). Changes made in the Eufy
    // app only arrive this way unless the HomeBase pushes them. 0 = only at connect.
    refreshSeconds: int(env.PROPERTY_REFRESH_SEC, 60, "PROPERTY_REFRESH_SEC"),
    liveMaxSeconds: int(env.LIVE_MAX_SEC, 120, "LIVE_MAX_SEC"),
    liveIdleSeconds: int(env.LIVE_IDLE_SEC, 10, "LIVE_IDLE_SEC"),
    stationIp: env.HOMEBASE_IP || "",
    stationSerial: env.HOMEBASE_SERIAL || "",
    simulator: ["1", "true", "yes"].includes(String(env.EUFY_SIMULATOR || "").toLowerCase()),
    // Not DEBUG: that name is taken by the npm "debug" package and would switch on library output too.
    debug: ["1", "true", "yes"].includes(String(env.BRIDGE_DEBUG || "").toLowerCase()),
    // Off by default (AGENTS.md rule 0); Home Assistant switches it in the integration options.
    cloudPush: ["1", "true", "yes"].includes(String(env.EUFY_CLOUD_PUSH || "").toLowerCase()),
    // Credentials from the environment take precedence over the stored file.
    credentials:
      env.EUFY_EMAIL && env.EUFY_PASSWORD
        ? { email: env.EUFY_EMAIL, password: env.EUFY_PASSWORD, country: env.EUFY_COUNTRY || "DE" }
        : null,
  };
}
