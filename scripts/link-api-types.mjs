import { readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

const output = fileURLToPath(new URL("../apps/web/.api-types", import.meta.url));
const web = createRequire(new URL("../apps/web/package.json", import.meta.url));
const store = createRequire(web.resolve("@relay/store"));
const prismaRuntime = store.resolve("@prisma/client/runtime/client");
async function link(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await link(path);
    else if (path.endsWith(".d.ts")) {
      const source = await readFile(path, "utf8");
      const linked = source.replace(
        /"(@relay\/store|@prisma\/client\/runtime\/client)"/g,
        (_match, name) => {
          const target =
            name === "@relay/store"
              ? resolve(output, "packages/store/src/index.js")
              : prismaRuntime;
          const specifier = relative(dirname(path), target).replaceAll("\\", "/");
          return JSON.stringify(specifier.startsWith(".") ? specifier : `./${specifier}`);
        },
      );
      if (linked !== source) await writeFile(path, linked);
    }
  }
}
await link(output);
