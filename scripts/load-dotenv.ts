import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

/**
 * Load dotenv files into process.env using the conventional cascade used by
 * Next.js, Vite, and create-react-app.
 *
 * Precedence, highest wins:
 *   1. Variables already present in process.env (real shell env, CI secrets).
 *   2. .env.{mode}.local
 *   3. .env.local            (skipped when mode === "test", per convention)
 *   4. .env.{mode}
 *   5. .env
 *
 * Rationale:
 * - A value exported in the shell (`PORT=4100 pnpm dev`) must always win over
 *   a file, so file loads never clobber an already-set variable.
 * - `.local` files are git-ignored, machine-specific overrides; the
 *   non-local files are the shared, committed defaults.
 * - Parsing uses Node's built-in `util.parseEnv` (Node >= 20.12) — no
 *   third-party dotenv dependency.
 *
 * Returns the list of files actually applied (for optional logging).
 */
export function loadDotenv(repoRoot: string, mode = process.env.NODE_ENV ?? "development"): string[] {
  // Lowest precedence first; later assignments only fill values that are not
  // already set, so iterating low -> high with "first writer wins" yields the
  // documented precedence.
  const candidates = [
    ".env",
    `.env.${mode}`,
    // .env.local is intentionally skipped for the test mode so test runs are
    // reproducible regardless of a developer's local overrides.
    ...(mode === "test" ? [] : [".env.local"]),
    `.env.${mode}.local`,
  ];

  const applied: string[] = [];
  // Walk high precedence -> low so the first writer of a key (higher
  // precedence) is the one that sticks.
  for (const relativePath of [...candidates].reverse()) {
    const absolutePath = path.join(repoRoot, relativePath);
    let contents: string;
    try {
      contents = readFileSync(absolutePath, "utf8");
    } catch {
      continue; // file absent — normal
    }
    const parsed = parseEnv(contents);
    let usedAny = false;
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
        usedAny = true;
      }
    }
    if (usedAny) applied.push(relativePath);
  }
  return applied;
}
