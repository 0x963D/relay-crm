import { readFile } from "node:fs/promises";
import { composition } from "../src/server/composition.ts";
import { importCsv } from "../src/server/intake/csv.ts";

const USAGE = "Usage: pnpm import:csv <file.csv>";

async function main(path: string | undefined): Promise<number> {
  if (path === undefined) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  try {
    const csvText = await readFile(path, "utf8");
    const { store } = composition();
    try {
      const report = await importCsv({ intake: store.intake, now: () => new Date() }, csvText);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return report.failures.length === 0 ? 0 : 1;
    } finally {
      await store.close();
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

process.exitCode = await main(process.argv[2]);
