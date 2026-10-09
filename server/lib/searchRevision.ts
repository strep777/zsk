const revisions = new Map<string, number>();
export function invalidateSearch(projectRoot: string): void { revisions.set(projectRoot, (revisions.get(projectRoot) || 0) + 1); }
export function searchRevision(projectRoot: string): number { return revisions.get(projectRoot) || 0; }
