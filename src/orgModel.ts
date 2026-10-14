"use strict";

/**
 * Pure (Power BI–independent) logic that turns flat SharePoint rows
 * (EmployeeID / ManagerID) into a single-rooted hierarchy.
 * Kept free of powerbi imports so it can be unit-tested in Node.
 */

export interface PersonRow {
    id: string;
    managerId: string | null;
    name: string;
    title: string;
    department: string;
    photoUrl: string;
    extras: { label: string; value: string }[];
    rowIndex: number;
}

export interface OrgNode {
    person: PersonRow | null;     // null only for the synthetic root above several top-level people
    children: OrgNode[];
    totalReports: number;         // all descendants
    depth: number;
}

export interface BuildResult {
    root: OrgNode;
    syntheticRoot: boolean;
    warnings: string[];
    count: number;
}

const norm = (v: unknown): string => (v === null || v === undefined ? "" : String(v).trim());

export function cleanKey(v: unknown): string | null {
    const s = norm(v);
    if (!s) return null;
    // SharePoint numbers often arrive as "12.0" or 12 – normalise so "12" === "12.0"
    if (/^-?\d+(\.0+)?$/.test(s)) return String(parseInt(s, 10));
    return s.toLowerCase();
}

export function buildOrg(rows: PersonRow[]): BuildResult {
    const warnings: string[] = [];
    const byId = new Map<string, PersonRow>();

    for (const r of rows) {
        const key = cleanKey(r.id);
        if (!key) continue;
        if (byId.has(key)) {
            warnings.push(`Duplicate Employee ID "${r.id}" – kept the first row.`);
            continue;
        }
        byId.set(key, r);
    }

    // Resolve parent, detecting self-references, missing managers and cycles.
    const parentOf = new Map<string, string | null>();
    for (const [key, r] of byId) {
        let mgr = cleanKey(r.managerId);
        if (mgr === key) {
            mgr = null;
        } else if (mgr && !byId.has(mgr)) {
            warnings.push(`Manager "${r.managerId}" for ${r.name || r.id} not found – shown at top level.`);
            mgr = null;
        }
        parentOf.set(key, mgr);
    }

    // Break cycles: walk up from each node; if we revisit, cut that edge.
    // `safe` memoises nodes already proven to reach a top-level person, keeping this O(n).
    const safe = new Set<string>();
    for (const key of byId.keys()) {
        if (safe.has(key)) continue;
        const path: string[] = [key];
        const onPath = new Set<string>([key]);
        let cur = parentOf.get(key) ?? null;
        let prev = key;
        while (cur && !safe.has(cur)) {
            if (onPath.has(cur)) {
                const p = byId.get(prev);
                warnings.push(`Reporting loop detected at ${p?.name || prev} – moved to top level.`);
                parentOf.set(prev, null);
                break;
            }
            onPath.add(cur);
            path.push(cur);
            prev = cur;
            cur = parentOf.get(cur) ?? null;
        }
        path.forEach(k => safe.add(k));
    }

    const nodes = new Map<string, OrgNode>();
    for (const [key, r] of byId) nodes.set(key, { person: r, children: [], totalReports: 0, depth: 0 });

    const tops: OrgNode[] = [];
    for (const [key, node] of nodes) {
        const p = parentOf.get(key);
        if (p) nodes.get(p)!.children.push(node);
        else tops.push(node);
    }

    const byName = (a: OrgNode, b: OrgNode) =>
        (b.children.length > 0 ? 1 : 0) - (a.children.length > 0 ? 1 : 0) ||
        (a.person?.name || "").localeCompare(b.person?.name || "");

    let root: OrgNode;
    let syntheticRoot = false;
    if (tops.length === 1) {
        root = tops[0];
    } else {
        root = { person: null, children: tops, totalReports: 0, depth: 0 };
        syntheticRoot = true;
    }

    // Iterative post-order to compute depth, counts and sort (avoids stack overflow on deep orgs).
    const stack: { n: OrgNode; d: number; visited: boolean }[] = [{ n: root, d: 0, visited: false }];
    while (stack.length) {
        const top = stack.pop()!;
        if (!top.visited) {
            top.n.depth = top.d;
            stack.push({ ...top, visited: true });
            for (const c of top.n.children) stack.push({ n: c, d: top.d + 1, visited: false });
        } else {
            top.n.children.sort(byName);
            top.n.totalReports = top.n.children.reduce((s, c) => s + 1 + c.totalReports, 0);
        }
    }

    return { root, syntheticRoot, warnings, count: byId.size };
}

export function initials(name: string): string {
    const parts = norm(name).split(/[\s,]+/).filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
