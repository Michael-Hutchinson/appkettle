// Single source of truth for the package version. Reads at runtime from the
// package.json one level above this file, so it works the same whether the
// script lives in src/ (tsx) or dist/ (compiled).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as {
  version: string;
  name: string;
};

export const VERSION = pkg.version;
export const NAME = pkg.name;
