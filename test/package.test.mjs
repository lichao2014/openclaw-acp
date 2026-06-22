import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const packageJson = JSON.parse(
  await readFile(path.join(process.cwd(), "package.json"), "utf8")
);

test("package metadata is publishable as an npx CLI", () => {
  assert.match(packageJson.name, /^@[^/]+\/openclaw-acp$/);
  assert.notEqual(packageJson.private, true);
  assert.deepEqual(packageJson.publishConfig, {
    access: "public"
  });
  assert.equal(packageJson.scripts.prepublishOnly, "npm run build");
  assert.deepEqual(packageJson.bin, {
    "openclaw-acp": "dist/cli.mjs"
  });
  assert.deepEqual(packageJson.files, [
    "dist",
    "README.md",
    "LICENSE",
    "package.json"
  ]);
});

test("README uses sourced acpx custom-agent examples", async () => {
  const readme = await readFile(path.join(process.cwd(), "README.md"), "utf8");
  const escapedPackageName = escapeRegExp(packageJson.name);

  assert.equal(readme.includes("agent_servers"), false);
  assert.match(readme, new RegExp(`acpx --agent "npx -y ${escapedPackageName}"`));
  assert.match(readme, /"agents":/);
  assert.match(readme, /"command": "npx"/);
  assert.match(readme, new RegExp(`"args": \\["-y", "${escapedPackageName}"\\]`));
});

test("source and test files do not contain local user paths or secret material", async () => {
  const forbiddenFragments = [
    "li" + "chao",
    "C:" + "\\\\" + "Users",
    "/" + "Users" + "/",
    "/" + "home" + "/",
    ".s" + "sh",
    "id_" + "rsa",
    "BEGIN " + "PRIVATE KEY",
    "sk" + "-",
    "ghp" + "_",
    "npm" + "_",
    "gateway-" + "token",
    "device-" + "token",
    "stored-device-" + "token",
    "q" + "claw"
  ];

  for (const file of await listCheckedFiles(process.cwd())) {
    const text = await readFile(file, "utf8");
    for (const fragment of forbiddenFragments) {
      assert.equal(
        text.includes(fragment),
        false,
        `${path.relative(process.cwd(), file)} contains forbidden test fixture text: ${fragment}`
      );
    }
  }
});

async function listCheckedFiles(rootDir) {
  const checkedRoots = ["src", "test", "scripts"].map((dir) => path.join(rootDir, dir));
  const files = [];
  for (const dir of checkedRoots) {
    files.push(...await listFiles(dir));
  }
  return files.filter((file) => /\.(js|mjs|ts)$/u.test(file));
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(fullPath));
      continue;
    }
    if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
