import { readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { evidenceDirectory } from "../apps/web/test/browser/paths.ts";

const section = readFileSync("README.md", "utf8")
  .split("## What is proven, and where")[1]
  ?.split("\n## ")[0];
if (!section) throw new Error("The README proof section is missing.");
const commands = [...section.matchAll(/`(pnpm[^`]+)`/g)].map((match) => match[1]);
if (!commands.length) throw new Error("The README proof section has no commands.");
const parent = evidenceDirectory;
mkdirSync(parent, { recursive: true });
const directory = mkdtempSync(join(parent, "proof-"));
try {
  for (const [index, command] of commands.entries()) {
    const match =
      /^pnpm exec (dotenv -- )?vitest run --project (unit|integration) ([\w/.-]+\.test\.ts)$/.exec(
        command,
      );
    if (!match) throw new Error(`Unsupported proof command: ${command}`);
    const file = match[3];
    const output = join(directory, `${index}.json`);
    const started = performance.now();
    const result = spawnSync(
      "pnpm",
      [...command.split(" ").slice(1), "--reporter=json", `--outputFile=${output}`],
      {
        encoding: "utf8",
        shell: process.platform === "win32",
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    if (result.status !== 0) throw new Error(`${command}\n${result.stdout}${result.stderr}`);
    const report = JSON.parse(readFileSync(output, "utf8"));
    const selected = report.testResults;
    if (
      selected.length !== 1 ||
      resolve(selected[0].name) !== resolve(file) ||
      !selected[0].assertionResults.length ||
      selected[0].assertionResults.some((test) => test.status !== "passed")
    )
      throw new Error(`${command} must run tests from exactly ${file}.`);
    console.log(
      JSON.stringify({
        command,
        file,
        tests: selected[0].assertionResults.length,
        seconds: Number(((performance.now() - started) / 1000).toFixed(2)),
      }),
    );
  }
} finally {
  rmSync(directory, { recursive: true });
}
