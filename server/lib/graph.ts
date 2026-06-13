import { GraphEdge, GraphInsight, GraphNode, KnowledgeGraph, Project, WikiFile } from "../types.js";
import { titleToWikiLinkMap, listWikiFiles } from "./wiki.js";

const maxGraphNodes = readPositiveInteger("LLM_WIKI_MAX_GRAPH_NODES", 1500);
const maxGraphEdges = readPositiveInteger("LLM_WIKI_MAX_GRAPH_EDGES", 12000);
const maxSourceOverlapFiles = readPositiveInteger("LLM_WIKI_MAX_SOURCE_OVERLAP_FILES", 4);

export async function buildKnowledgeGraph(project: Project): Promise<KnowledgeGraph> {
  const allFiles = await listWikiFiles(project, { limit: maxGraphNodes });
  const files = allFiles
    .sort((a, b) => scoreGraphFile(b) - scoreGraphFile(a) || b.mtime.localeCompare(a.mtime))
    .slice(0, maxGraphNodes);
  const titleMap = titleToWikiLinkMap(files);
  const nodes: GraphNode[] = files.map((file, index) => ({
    id: file.path,
    title: file.title,
    type: file.type,
    path: file.path,
    community: 0,
    weight: Math.max(1, file.links.length + file.sources.length),
    ...circlePosition(index, files.length)
  }));
  const edges = mergeEdges([
    ...linkEdges(files, titleMap, maxGraphEdges),
    ...sourceOverlapEdges(files, maxGraphEdges),
    ...typeAffinityEdges(files, maxGraphEdges)
  ]).slice(0, maxGraphEdges);
  assignCommunities(nodes, edges);
  return {
    nodes,
    edges,
    insights: graphInsights(nodes, edges)
  };
}

function linkEdges(files: WikiFile[], titleMap: Map<string, WikiFile>, limit: number): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const file of files) {
    for (const link of file.links) {
      const target = titleMap.get(link.toLowerCase());
      if (!target || target.path === file.path) continue;
      edges.push({
        id: `${file.path}->${target.path}:link`,
        source: file.path,
        target: target.path,
        weight: 3,
        reasons: ["wikilink"]
      });
      if (edges.length >= limit) return edges;
    }
  }
  return edges;
}

function sourceOverlapEdges(files: WikiFile[], limit: number): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const sourceIndex = new Map<string, WikiFile[]>();

  for (const file of files) {
    for (const source of new Set(file.sources)) {
      const bucket = sourceIndex.get(source) ?? [];
      bucket.push(file);
      sourceIndex.set(source, bucket);
    }
  }

  for (const [source, relatedFiles] of sourceIndex) {
    const selected = relatedFiles
      .sort((a, b) => graphTypePriority(a.type) - graphTypePriority(b.type) || b.mtime.localeCompare(a.mtime))
      .slice(0, maxSourceOverlapFiles);
    for (let i = 0; i < selected.length; i += 1) {
      for (let j = i + 1; j < selected.length; j += 1) {
        const left = selected[i];
        const right = selected[j];
        if (left.path === right.path) continue;
        edges.push({
          id: `${left.path}->${right.path}:source`,
          source: left.path,
          target: right.path,
          weight: 3,
          reasons: [`shared source: ${source}`]
        });
        if (edges.length >= limit) return edges;
      }
    }
  }
  return edges;
}

function typeAffinityEdges(files: WikiFile[], limit: number): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const sourcePages = files.filter((file) => file.type === "source");
  const extracts = files.filter((file) => file.type === "source_extract");
  const extractBySource = new Map<string, WikiFile>();

  for (const extract of extracts) {
    for (const source of extract.sources) {
      if (!extractBySource.has(source)) extractBySource.set(source, extract);
    }
  }

  for (const source of sourcePages) {
    const related = source.sources.map((item) => extractBySource.get(item)).find(Boolean);
    if (!related) continue;
    edges.push({
      id: `${source.path}->${related.path}:converted`,
      source: source.path,
      target: related.path,
      weight: 4,
      reasons: ["converted markdown"]
    });
    if (edges.length >= limit) return edges;
  }
  return edges;
}

function mergeEdges(edges: GraphEdge[]): GraphEdge[] {
  const merged = new Map<string, GraphEdge>();
  for (const edge of edges) {
    const key = [edge.source, edge.target].sort().join("::");
    const existing = merged.get(key);
    if (existing) {
      existing.weight += edge.weight;
      existing.reasons = [...new Set([...existing.reasons, ...edge.reasons])];
    } else {
      merged.set(key, { ...edge, id: key });
    }
  }
  return [...merged.values()];
}

function assignCommunities(nodes: GraphNode[], edges: GraphEdge[]): void {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const edge of edges) {
    adjacency.get(edge.source)?.push(edge.target);
    adjacency.get(edge.target)?.push(edge.source);
  }

  let community = 0;
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    const stack = [node.id];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const target = nodeMap.get(id);
      if (target) target.community = community;
      for (const next of adjacency.get(id) ?? []) stack.push(next);
    }
    community += 1;
  }
}

function graphInsights(nodes: GraphNode[], edges: GraphEdge[]): GraphInsight[] {
  const insights: GraphInsight[] = [];
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  const isolated = nodes.filter((node) => (degree.get(node.id) ?? 0) === 0 && node.type !== "index");
  if (isolated.length) {
    insights.push({
      kind: "gap",
      title: "存在未连接页面",
      detail: `${isolated.length} 个页面没有图谱连接，建议补充来源或 Wikilink。`,
      paths: isolated.slice(0, 6).map((node) => node.path)
    });
  }

  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const bridge = edges
    .filter((edge) => {
      const source = nodeMap.get(edge.source);
      const target = nodeMap.get(edge.target);
      return source && target && source.community !== target.community;
    })
    .sort((a, b) => b.weight - a.weight)[0];
  if (bridge) {
    insights.push({
      kind: "bridge",
      title: "跨簇连接",
      detail: `发现跨主题连接：${bridge.reasons.join(", ")}。`,
      paths: [bridge.source, bridge.target]
    });
  }

  const communities = new Map<number, number>();
  for (const node of nodes) communities.set(node.community, (communities.get(node.community) ?? 0) + 1);
  const largest = [...communities.entries()].sort((a, b) => b[1] - a[1])[0];
  if (largest) {
    insights.push({
      kind: "cluster",
      title: "最大知识簇",
      detail: `社区 ${largest[0]} 包含 ${largest[1]} 个页面。`,
      paths: nodes.filter((node) => node.community === largest[0]).slice(0, 8).map((node) => node.path)
    });
  }

  return insights;
}

function circlePosition(index: number, total: number): { x: number; y: number } {
  const angle = total ? (index / total) * Math.PI * 2 : 0;
  const radius = Math.max(90, Math.min(260, total * 14));
  return {
    x: Math.round(320 + Math.cos(angle) * radius),
    y: Math.round(260 + Math.sin(angle) * radius)
  };
}

function scoreGraphFile(file: WikiFile): number {
  return graphTypePriority(file.type) * -100000 + file.links.length * 10 + file.sources.length;
}

function graphTypePriority(type: string): number {
  if (type === "index" || type === "synthesis") return 0;
  if (type === "source") return 1;
  if (type === "source_extract") return 2;
  if (type === "concept" || type === "entity") return 3;
  return 4;
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
