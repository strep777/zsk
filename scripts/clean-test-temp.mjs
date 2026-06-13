import fs from "node:fs/promises";
import path from "node:path";

const workspace = process.cwd();
const testsRoot = path.resolve(workspace, "tests");

async function main() {
  const entries = await fs.readdir(testsRoot, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });

  let removed = 0;
  let skipped = 0;
  let permissionBlocked = false;
  for (const entry of entries) {
    if (permissionBlocked) break;
    if (!entry.isDirectory() || !entry.name.startsWith(".tmp-")) continue;
    const target = path.resolve(testsRoot, entry.name);
    if (!target.startsWith(`${testsRoot}${path.sep}`)) {
      throw new Error(`Refusing to remove outside tests: ${target}`);
    }
    try {
      await fs.rm(target, { recursive: true, force: true, maxRetries: 1, retryDelay: 10 });
      removed += 1;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      const message = error instanceof Error ? error.message : String(error);
      skipped += 1;
      console.warn(`Skipped stale test temp directory: ${target} (${code || message})`);
      if (code === "EPERM" || code === "EACCES") {
        permissionBlocked = true;
      }
    }
  }

  if (removed) {
    console.log(`Removed ${removed} stale test temp director${removed === 1 ? "y" : "ies"}.`);
  }
  if (skipped) {
    console.warn(`Skipped ${skipped} stale test temp director${skipped === 1 ? "y" : "ies"} due to filesystem permissions.`);
  }
}

await main();
