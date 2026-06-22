import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

const entryPath = join("dist", "cli.mjs");
const source = `#!/usr/bin/env node
import { formatCliError, main } from "./cli.js";

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(\`\${formatCliError(error)}\\n\`);
  process.exitCode = 1;
});
`;

await writeFile(entryPath, source, "utf8");

if (process.platform !== "win32") {
  await chmod(entryPath, 0o755);
}
