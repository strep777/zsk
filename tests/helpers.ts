import fs from "node:fs/promises";
import path from "node:path";
import { Project } from "../server/types.js";
import { initializeProject, safeJoin } from "../server/lib/storage.js";

export async function makeProject(name = "测试知识库"): Promise<Project> {
  const root = await fs.mkdtemp(path.join(process.cwd(), "tests", ".tmp-"));
  const timestamp = new Date().toISOString();
  const project: Project = {
    id: path.basename(root),
    name,
    description: "用于自动化测试",
    createdAt: timestamp,
    updatedAt: timestamp,
    root
  };
  await initializeProject(project);
  return project;
}

export async function writeProjectFile(project: Project, relativePath: string, content: string): Promise<string> {
  const filePath = safeJoin(project.root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

export function multerFile(filePath: string, originalName: string, size = 0): Express.Multer.File {
  return {
    fieldname: "files",
    originalname: originalName,
    encoding: "7bit",
    mimetype: "application/octet-stream",
    destination: path.dirname(filePath),
    filename: path.basename(filePath),
    path: filePath,
    size,
    stream: undefined as unknown as Express.Multer.File["stream"],
    buffer: undefined as unknown as Express.Multer.File["buffer"]
  };
}
