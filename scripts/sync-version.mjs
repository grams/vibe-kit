// Lancé par `npm version` : recopie la version de package.json dans src/version.ts.
import { readFileSync, writeFileSync } from "node:fs";
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
writeFileSync(
  "src/version.ts",
  `// Mis à jour automatiquement par \`npm version\` (scripts/sync-version.mjs).\nexport const VERSION = "${version}";\n`,
);
