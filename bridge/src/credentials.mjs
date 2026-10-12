// Persists the Eufy credentials so the bridge can log in again after a restart.
// The file is written with mode 0600 and never exposed through the API.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class CredentialStore {
  constructor(dataDir) {
    this.file = join(dataDir, "credentials.json");
    mkdirSync(dataDir, { recursive: true });
  }

  load() {
    if (!existsSync(this.file)) return null;
    try {
      const c = JSON.parse(readFileSync(this.file, "utf8"));
      return c.email && c.password ? c : null;
    } catch {
      return null;
    }
  }

  save({ email, password, country }) {
    writeFileSync(this.file, JSON.stringify({ email, password, country }), { mode: 0o600 });
    chmodSync(this.file, 0o600); // also tighten an already existing file
  }
}
