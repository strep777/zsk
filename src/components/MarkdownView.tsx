import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { parseMarkdown } from "../../server/lib/markdown";
import { WikiFile } from "../types";

export interface MarkdownViewProps {
  content: string;
  projectId?: string;
  documentPath?: string;
  files?: WikiFile[];
  onOpen?: (path: string) => void;
}

interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
}

function remarkWikiLinks() {
  return (tree: MarkdownNode) => {
    function walk(node: MarkdownNode) {
      if (!node.children || node.type === "link" || node.type === "code" || node.type === "inlineCode") return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || !child.value) { walk(child); return [child]; }
        const nodes: MarkdownNode[] = [];
        let end = 0;
        for (const match of child.value.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
          const start = match.index!;
          if (start > end) nodes.push({ type: "text", value: child.value.slice(end, start) });
          nodes.push({ type: "link", url: `#wiki-link=${encodeURIComponent(match[1].trim())}`, children: [{ type: "text", value: match[2]?.trim() || match[1].trim() }] });
          end = start + match[0].length;
        }
        if (!nodes.length) return [child];
        if (end < child.value.length) nodes.push({ type: "text", value: child.value.slice(end) });
        return nodes;
      });
    }
    walk(tree);
  };
}

export function resolveDocumentLink(href: string, documentPath?: string, files: WikiFile[] = []): string | undefined {
  let target: string;
  try { target = decodeURIComponent(href.replace(/^#wiki-link=/, "")); } catch { return undefined; }
  target = target.split("#")[0];
  if (href.startsWith("#wiki-link=")) {
    const exact = files.find((file) => file.path === target || file.path === `wiki/${target}` || file.path === `wiki/${target}.md`);
    if (exact) return exact.path;
    const matching = files.filter((file) => file.title === target || file.path.split("/").pop()?.replace(/\.md$/i, "") === target);
    const directory = documentPath?.slice(0, documentPath.lastIndexOf("/") + 1);
    return matching.find((file) => directory && file.path.startsWith(directory))?.path || matching[0]?.path || (/^wiki\/.+\.md$/i.test(target) ? target : undefined);
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith("//") || !target || href.startsWith("#")) return undefined;
  const base = target.startsWith("wiki/") || target.startsWith("raw/") || target.startsWith("/") ? "/" : `/${documentPath?.slice(0, documentPath.lastIndexOf("/") + 1) || "wiki/"}`;
  try {
    const resolved = decodeURIComponent(new URL(href.split("#")[0], `https://wiki.local${base}`).pathname.slice(1));
    return resolved.startsWith("wiki/") || resolved.startsWith("raw/sources/") ? resolved : undefined;
  } catch { return undefined; }
}

export function MarkdownView({ content, projectId, documentPath, files, onOpen }: MarkdownViewProps) {
  const body = parseMarkdown(content).body;
  return (
    <article className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath, remarkWikiLinks]} rehypePlugins={[rehypeKatex]}
        components={{
          a: ({ href = "", children }) => {
            const path = resolveDocumentLink(href, documentPath, files);
            if (path && onOpen) return <a href={href} onClick={(event) => { event.preventDefault(); onOpen(path); }}>{children}</a>;
            if (href.startsWith("#wiki-link=")) return <span className="unresolved-wiki-link" title="对应页面尚未生成或不在当前目录中">{children}</span>;
            return <a href={href} target={/^https?:\/\//i.test(href) ? "_blank" : undefined} rel="noopener noreferrer">{children}</a>;
          },
          img: ({ src, alt }) => {
            let imageSource = src;
            if (projectId && src && !/^(?:https?:|data:|\/api\/|\/\/)/i.test(src)) {
              try {
              const base = `https://wiki.local/${documentPath?.slice(0, documentPath.lastIndexOf("/") + 1) || ""}`;
              const assetPath = decodeURIComponent(new URL(src.startsWith("raw/") ? `/${src}` : src, base).pathname.slice(1));
              if (assetPath.startsWith("raw/assets/")) imageSource = `/api/v1/projects/${encodeURIComponent(projectId)}/assets?path=${encodeURIComponent(assetPath)}`;
              } catch { imageSource = undefined; }
            }
            return <img src={imageSource} alt={alt || "图片"} loading="lazy" />;
          }
        }}>
        {body || "_没有可预览内容。_"}
      </ReactMarkdown>
    </article>
  );
}
