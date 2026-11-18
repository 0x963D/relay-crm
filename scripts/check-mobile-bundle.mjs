import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { env } from "node:process";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = process.argv[2]
  ? resolve(process.argv[2])
  : await mkdtemp(join(tmpdir(), "relay-mobile-"));
try {
  const cli = resolve(root, "apps/mobile/node_modules/expo/bin/cli");
  const result = spawnSync(
    process.execPath,
    [cli, "export", "--platform", "all", "--source-maps", "--output-dir", directory],
    {
      cwd: resolve(root, "apps/mobile"),
      stdio: "inherit",
      env: { ...env, CI: "1" },
    },
  );
  assert.equal(result.status, 0, "Both native bundles must compile with Hermes.");

  async function files(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    return (
      await Promise.all(
        entries.map((entry) =>
          entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)],
        ),
      )
    ).flat();
  }
  const all = await files(directory);
  const banned =
    /(?:^|[/\\])(?:node_modules[/\\](?:\.pnpm[/\\])?(?:@prisma[+\\/]client|better-auth|next)(?:[@/\\]|$)|(?:apps[/\\])?web[/\\]src[/\\]server(?:[/\\]|$)|packages[/\\]store(?:[/\\]|$))/;
  for (const source of [
    "../../apps/web/src/server/rpc.ts",
    "../../packages/store/src/index.ts",
    "..\\apps\\web\\src\\server\\rpc.ts",
    "node_modules/.pnpm/@prisma+client@7/node_modules/@prisma/client/index.js",
  ]) {
    assert(banned.test(source), `Bundle policy must reject ${source}.`);
  }
  function sources(map) {
    if (Array.isArray(map.sources)) return map.sources;
    assert(Array.isArray(map.sections), "Metro must emit sources or sections.");
    return map.sections.flatMap((section) => sources(section.map));
  }
  for (const platform of ["android", "ios"]) {
    const maps = all.filter(
      (file) => file.endsWith(".map") && file.split(/[\\/]/).includes(platform),
    );
    assert(maps.length > 0, `${platform} must have a source map.`);
    let count = 0;
    for (const map of maps) {
      assert(map.endsWith(".hbc.map"), `${platform} must export Hermes bytecode.`);
      const parsed = JSON.parse(await readFile(map, "utf8"));
      const names = sources(parsed);
      const forbidden = names.filter((source) => banned.test(source));
      assert.deepEqual(forbidden, [], `${platform} includes server modules.`);
      count += names.length;
      assert((await readFile(map.slice(0, -4))).length > 0, `${platform} bytecode is missing.`);
    }
    console.log(
      `${platform}: Hermes compiled, ${count} source modules checked, no server packages or workspace server paths`,
    );
  }
} finally {
  if (!process.argv[2]) await rm(directory, { recursive: true, force: true });
}
