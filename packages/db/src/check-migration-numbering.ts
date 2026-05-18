import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));
const journalPath = fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url));

type JournalFile = {
  entries?: Array<{
    idx?: number;
    tag?: string;
  }>;
};

function migrationNumber(value: string): string | null {
  const match = value.match(/^(\d{4})_/);
  return match ? match[1] : null;
}

function ensureNoDuplicates(values: string[], label: string) {
  const seen = new Map<string, string>();

  for (const value of values) {
    const number = migrationNumber(value);
    if (!number) {
      throw new Error(`${label} entry does not start with a 4-digit migration number: ${value}`);
    }
    const existing = seen.get(number);
    if (existing) {
      throw new Error(`Duplicate migration number ${number} in ${label}: ${existing}, ${value}`);
    }
    seen.set(number, value);
  }
}

function ensureStrictlyOrdered(values: string[], label: string) {
  const sorted = [...values].sort();
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] !== sorted[index]) {
      throw new Error(
        `${label} are out of order at position ${index}: expected ${sorted[index]}, found ${values[index]}`,
      );
    }
  }
}

function ensureJournalMatchesFiles(migrationFiles: string[], journalTags: string[]) {
  const journalFiles = journalTags.map((tag) => `${tag}.sql`);

  if (journalFiles.length !== migrationFiles.length) {
    throw new Error(
      `Migration journal/file count mismatch: journal has ${journalFiles.length}, files have ${migrationFiles.length}`,
    );
  }

  for (let index = 0; index < migrationFiles.length; index += 1) {
    const migrationFile = migrationFiles[index];
    const journalFile = journalFiles[index];
    if (migrationFile !== journalFile) {
      throw new Error(
        `Migration journal/file order mismatch at position ${index}: journal has ${journalFile}, files have ${migrationFile}`,
      );
    }
  }
}

function ensureLatestSnapshotPresent(journalTags: string[], snapshotFiles: string[]) {
  if (journalTags.length === 0) return;
  const latestTag = journalTags[journalTags.length - 1];
  const latestNumber = migrationNumber(latestTag);
  if (!latestNumber) {
    throw new Error(`Latest journal entry tag has no migration number: ${latestTag}`);
  }
  const expectedSnapshot = `${latestNumber}_snapshot.json`;
  if (!snapshotFiles.includes(expectedSnapshot)) {
    throw new Error(
      `Latest migration ${latestTag} is missing its drizzle snapshot at meta/${expectedSnapshot}. ` +
        `This happens when a migration .sql + journal entry are added by hand without running ` +
        `\`pnpm db:generate\`. The next db:generate will diff against the previous (stale) snapshot ` +
        `and emit a duplicate migration. Fix: run \`pnpm db:generate\` from a clean schema state, ` +
        `or hand-roll the snapshot to match the new schema.`,
    );
  }
}

async function main() {
  const migrationFiles = (await readdir(migrationsDir))
    .filter((entry) => entry.endsWith(".sql"))
    .sort();

  ensureNoDuplicates(migrationFiles, "migration files");
  ensureStrictlyOrdered(migrationFiles, "migration files");

  const rawJournal = await readFile(journalPath, "utf8");
  const journal = JSON.parse(rawJournal) as JournalFile;
  const journalTags = (journal.entries ?? [])
    .map((entry, index) => {
      if (typeof entry.tag !== "string" || entry.tag.length === 0) {
        throw new Error(`Migration journal entry ${index} is missing a tag`);
      }
      return entry.tag;
    });

  ensureNoDuplicates(journalTags, "migration journal");
  ensureStrictlyOrdered(journalTags, "migration journal");
  ensureJournalMatchesFiles(migrationFiles, journalTags);

  const metaDir = fileURLToPath(new URL("./migrations/meta", import.meta.url));
  const snapshotFiles = (await readdir(metaDir)).filter((entry) =>
    entry.endsWith("_snapshot.json"),
  );
  ensureLatestSnapshotPresent(journalTags, snapshotFiles);
}

await main();
