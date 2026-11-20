import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

const project = fileURLToPath(new URL("../apps/web/", import.meta.url));
const output = join(project, ".api-types");
const web = createRequire(new URL("../apps/web/package.json", import.meta.url));
const store = createRequire(web.resolve("@relay/store"));
const prismaRuntime = store.resolve("@prisma/client/runtime/client");
await mkdir(output, { recursive: true });
const staging = await mkdtemp(join(output, "emit-"));

async function declarations(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await declarations(path)));
    else if (path.endsWith(".d.ts")) files.push(path);
  }
  return files;
}

try {
  execFileSync(
    process.execPath,
    [web.resolve("typescript/bin/tsc"), "--project", "tsconfig.api.json", "--outDir", staging],
    { cwd: project, stdio: "inherit" },
  );
  const files = await declarations(staging);
  for (const path of files) {
    const destination = join(output, relative(staging, path));
    const source = await readFile(path, "utf8");
    const linked = source.replace(
      /"(@relay\/store|@prisma\/client\/runtime\/client)"/g,
      (_match, name) => {
        const target =
          name === "@relay/store" ? resolve(output, "packages/store/src/index.js") : prismaRuntime;
        const specifier = relative(dirname(destination), target).replaceAll("\\", "/");
        return JSON.stringify(specifier.startsWith(".") ? specifier : `./${specifier}`);
      },
    );
    if (linked !== source) await writeFile(path, linked);
  }
  for (const path of files) {
    const destination = join(output, relative(staging, path));
    await mkdir(dirname(destination), { recursive: true });
    await rename(path, destination);
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}
