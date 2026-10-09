import { getProject } from "./lib/storage.js";
import { repairGeneratedTopicPages } from "./lib/wiki.js";

// Run with the application stopped: this maintenance process shares its data
// directory, but cannot share the running server's in-memory write locks.
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--project" || !args[1].trim()) {
  console.error("用法：npm run repair:topics -- --project <知识库ID>。请先停止应用服务，避免与摄入同时写入。");
  process.exitCode = 1;
} else {
  try {
    const project = await getProject(args[1]);
    const result = await repairGeneratedTopicPages(project);
    console.log(`知识库 ${project.name}：修复 ${result.repaired} 页，保留 ${result.skipped} 页。`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
