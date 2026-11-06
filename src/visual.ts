"use strict";

import powerbi from "powerbi-visuals-api";
import { FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";
import { select, Selection } from "d3-selection";
import { hierarchy, tree } from "d3-hierarchy";
import { zoom, zoomIdentity, ZoomBehavior } from "d3-zoom";
import "d3-transition";
import "./../style/visual.less";

import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbi.extensibility.visual.IVisual;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import ISelectionManager = powerbi.extensibility.ISelectionManager;
import ISelectionId = powerbi.visuals.ISelectionId;
import DataView = powerbi.DataView;
import VisualTooltipDataItem = powerbi.extensibility.VisualTooltipDataItem;

import { valueFormatter } from "powerbi-visuals-utils-formattingutils";
import { VisualFormattingSettingsModel } from "./settings";
import { buildOrg, cleanKey, initials, OrgNode, PersonRow, BuildResult } from "./orgModel";

/** A card (or "+N more" card) placed on the canvas. */
interface Placed {
    data: OrgNode;
    x: number;
    y: number;
    depth: number;
    parent: Placed | null;
    /** True for members of a stacked team list (drawn with a side spine instead of an elbow). */
    stacked: boolean;
}
type PNode = Placed;

interface LayoutChoice { vertical: boolean; stacked: boolean; }
interface LayoutResult { placed: Placed[]; bounds: { x: number; y: number; width: number; height: number } | null; topPos: { x: number; y: number } | null; }

const ROOT_KEY = "__synthetic_root__";
/** Direct reports shown per manager before a "+N more" card. */
const PAGE_SIZE = 50;
/** Upper bound on cards drawn by "Expand all", so very large orgs stay responsive. */
const RENDER_BUDGET = 1500;
/** When a search result sits deeper than this, show only the branch around it instead of every level above. */
const MAX_REVEAL_DEPTH = 40;
const FOCUS_LEVELS_ABOVE = 8;
/** Never zoom out further than this when fitting; below it cards become unreadable. */
const MIN_FIT_SCALE = 0.3;

export class Visual implements IVisual {
    private host: IVisualHost;
    private events: powerbi.extensibility.IVisualEventService;
    private allowInteractions = true;
    private hc: { on: boolean; fg: string; bg: string; sel: string } = { on: false, fg: "", bg: "", sel: "" };
    private selectionManager: ISelectionManager;
    private formattingSettings: VisualFormattingSettingsModel;
    private formattingSettingsService: FormattingSettingsService;

    private container: HTMLElement;
    private toolbar: HTMLDivElement;
    private searchInput: HTMLInputElement;
    private searchResults: HTMLDivElement;
    private warnBadge: HTMLSpanElement;
    private infoNote: HTMLSpanElement;
    private landing: HTMLDivElement;
    private svg: Selection<SVGSVGElement, unknown, null, undefined>;
    private viewport: Selection<SVGGElement, unknown, null, undefined>;
    private linkLayer: Selection<SVGGElement, unknown, null, undefined>;
    private nodeLayer: Selection<SVGGElement, unknown, null, undefined>;
    private defs: Selection<SVGDefsElement, unknown, null, undefined>;
    private zoomBehavior: ZoomBehavior<SVGSVGElement, unknown>;

    private model: BuildResult | null = null;
    private selectionIds = new Map<number, ISelectionId>();
    private expanded = new Set<string>();
    /** Per-manager count of direct reports currently shown (default PAGE_SIZE). */
    private shown = new Map<string, number>();
    /** Reports revealed by search that sit beyond their manager's shown page. */
    private pinned = new Map<string, Set<OrgNode>>();
    private budgetHit = false;
    /** When set, the chart is drawn from this person down (used for very deep search results). */
    private focusRoot: OrgNode | null = null;
    /** Layout actually in use (resolved from the Auto settings). */
    private layout: LayoutChoice = { vertical: true, stacked: true };
    /** When true, the Auto settings are re-evaluated on the next render. */
    private layoutDirty = true;
    private measureCtx: CanvasRenderingContext2D | null = null;
    private fontFamily = "Segoe UI, sans-serif";
    private dataSignature = "";
    private lastInitialDepth = -1;
    private highlightKey: string | null = null;
    private width = 0;
    private height = 0;
    private didInitialFit = false;
    private bounds: { x: number; y: number; width: number; height: number } | null = null;
    /** Position of the top card, used to anchor the view when the whole chart can't fit legibly. */
    private topPos: { x: number; y: number } | null = null;

    constructor(options: VisualConstructorOptions) {
        this.host = options.host;
        this.events = options.host.eventService;
        this.allowInteractions = options.host.hostCapabilities?.allowInteractions !== false;
        this.selectionManager = this.host.createSelectionManager();
        this.formattingSettingsService = new FormattingSettingsService();
        this.container = options.element;
        this.container.classList.add("orgchart-root");

        this.buildToolbar();

        this.landing = document.createElement("div");
        this.landing.className = "orgchart-landing";
        this.container.appendChild(this.landing);

        this.svg = select(this.container).append("svg").attr("class", "orgchart-svg") as any;
        this.defs = this.svg.append("defs");
        this.viewport = this.svg.append("g").attr("class", "viewport");
        this.linkLayer = this.viewport.append("g").attr("class", "links");
        this.nodeLayer = this.viewport.append("g").attr("class", "nodes");

        this.zoomBehavior = zoom<SVGSVGElement, unknown>()
            .scaleExtent([0.05, 3])
            .filter((event: any) => !event.button && event.type !== "dblclick")
            .on("zoom", (event) => this.viewport.attr("transform", event.transform.toString()));
        this.svg.call(this.zoomBehavior);

        // Click on blank canvas clears the selection.
        this.svg.on("click", (event: MouseEvent) => {
            if (event.target === this.svg.node()) {
                this.selectionManager.clear().then(() => this.applySelectionStyles());
            }
        });
        this.svg.on("contextmenu", (event: MouseEvent) => {
            if (event.target === this.svg.node()) {
                this.selectionManager.showContextMenu({}, { x: event.clientX, y: event.clientY });
                event.preventDefault();
            }
        });

        this.selectionManager.registerOnSelectCallback(() => this.applySelectionStyles());
    }

    // ---------------------------------------------------------------- toolbar

    private buildToolbar(): void {
        const tb = document.createElement("div");
        tb.className = "orgchart-toolbar";

        const searchWrap = document.createElement("div");
        searchWrap.className = "search-wrap";
        this.searchInput = document.createElement("input");
        this.searchInput.type = "search";
        this.searchInput.placeholder = "Find a person…";
        this.searchInput.setAttribute("aria-label", "Find a person");
        this.searchResults = document.createElement("div");
        this.searchResults.className = "search-results";
        this.searchResults.hidden = true;
        searchWrap.appendChild(this.searchInput);
        searchWrap.appendChild(this.searchResults);
        tb.appendChild(searchWrap);

        this.searchInput.addEventListener("input", () => this.onSearchInput());
        this.searchInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                const first = this.searchResults.querySelector("button") as HTMLButtonElement | null;
                if (first) first.click();
            } else if (e.key === "Escape") {
                this.searchInput.value = "";
                this.searchResults.hidden = true;
            }
        });
        this.searchInput.addEventListener("blur", () => setTimeout(() => (this.searchResults.hidden = true), 200));

        const mkBtn = (label: string, title: string, onClick: () => void) => {
            const b = document.createElement("button");
            b.type = "button";
            b.textContent = label;
            b.title = title;
            b.addEventListener("click", onClick);
            tb.appendChild(b);
            return b;
        };
        mkBtn("Expand all", "Expand every level", () => this.expandAll());
        mkBtn("Collapse", "Reset to the default levels", () => { this.resetExpansion(); this.render(true); });
        mkBtn("Fit", "Fit the chart to the visual", () => this.fit(true));

        this.infoNote = document.createElement("span");
        this.infoNote.className = "info-note";
        this.infoNote.hidden = true;
        tb.appendChild(this.infoNote);

        this.warnBadge = document.createElement("span");
        this.warnBadge.className = "warn-badge";
        this.warnBadge.hidden = true;
        tb.appendChild(this.warnBadge);

        this.toolbar = tb;
        this.container.appendChild(tb);
    }

    private onSearchInput(): void {
        const q = this.searchInput.value.trim().toLowerCase();
        while (this.searchResults.firstChild) this.searchResults.removeChild(this.searchResults.firstChild);
        if (!q || !this.model) { this.searchResults.hidden = true; return; }

        const hits: OrgNode[] = [];
        const stack: OrgNode[] = [this.model.root];
        while (stack.length && hits.length < 12) {
            const n = stack.pop()!;
            const p = n.person;
            if (p && (p.name.toLowerCase().includes(q) || p.title.toLowerCase().includes(q) || p.department.toLowerCase().includes(q))) hits.push(n);
            for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
        }

        if (!hits.length) {
            const empty = document.createElement("div");
            empty.className = "no-hit";
            empty.textContent = "No matches";
            this.searchResults.appendChild(empty);
        }
        for (const h of hits) {
            const b = document.createElement("button");
            b.type = "button";
            const nm = document.createElement("strong");
            nm.textContent = h.person!.name;
            const tt = document.createElement("span");
            tt.textContent = h.person!.title;
            b.appendChild(nm);
            b.appendChild(tt);
            b.addEventListener("mousedown", (e) => e.preventDefault());
            b.addEventListener("click", () => {
                this.searchResults.hidden = true;
                this.revealPerson(h);
            });
            this.searchResults.appendChild(b);
        }
        this.searchResults.hidden = false;
    }

    // ---------------------------------------------------------------- update

    public update(options: VisualUpdateOptions): void {
        this.events.renderingStarted(options);
        try {
            this.doUpdate(options);
            this.events.renderingFinished(options);
        } catch (e) {
            this.events.renderingFailed(options, String(e));
        }
    }

    private doUpdate(options: VisualUpdateOptions): void {
        const pal = this.host.colorPalette as any;
        this.hc = {
            on: !!pal.isHighContrast,
            fg: pal.foreground?.value || "#000",
            bg: pal.background?.value || "#fff",
            sel: pal.foregroundSelected?.value || pal.foreground?.value || "#000"
        };
        this.width = options.viewport.width;
        this.height = options.viewport.height;

        const dv: DataView | undefined = options.dataViews && options.dataViews[0];
        this.formattingSettings = this.formattingSettingsService.populateFormattingSettingsModel(VisualFormattingSettingsModel, dv);

        const showToolbar = this.formattingSettings.layoutCard.showSearch.value;
        this.toolbar.style.display = showToolbar ? "" : "none";
        const tbH = showToolbar ? this.toolbar.offsetHeight : 0;
        this.svg.attr("width", this.width).attr("height", Math.max(0, this.height - tbH));

        const type = options.type;
        const onlyResize = (type & powerbi.VisualUpdateType.Resize) && !(type & powerbi.VisualUpdateType.Data) && !(type & powerbi.VisualUpdateType.Style);

        if (!dv || !dv.table || !this.hasRequiredRoles(dv)) {
            this.model = null;
            this.showLanding(true);
            return;
        }
        this.showLanding(false);
        if (onlyResize && this.model) {
            // With an Auto setting, a new visual size can mean a better arrangement.
            if (this.isAuto()) { this.layoutDirty = true; this.render(false); this.fit(false); }
            return;
        }
        this.layoutDirty = true;

        const rows = this.parseRows(dv);
        this.model = buildOrg(rows);

        const sig = rows.length + "|" + rows.slice(0, 50).map(r => r.id).join(",");
        const depth = this.formattingSettings.layoutCard.initialDepth.value;
        if (sig !== this.dataSignature || depth !== this.lastInitialDepth) {
            this.dataSignature = sig;
            this.lastInitialDepth = depth;
            this.resetExpansion();
            this.didInitialFit = false;
        }

        const w = this.model.warnings, wn = this.model.warningCount;
        this.warnBadge.hidden = wn === 0;
        this.warnBadge.textContent = `⚠ ${wn.toLocaleString()}`;
        this.warnBadge.title = w.slice(0, 25).join("\n") + (wn > 25 ? `\n…and ${(wn - 25).toLocaleString()} more` : "");

        this.render(false);
        if (!this.didInitialFit) {
            this.fit(false);
            this.didInitialFit = true;
        }
    }

    public getFormattingModel(): powerbi.visuals.FormattingModel {
        return this.formattingSettingsService.buildFormattingModel(this.formattingSettings);
    }

    private hasRequiredRoles(dv: DataView): boolean {
        const cols = dv.table?.columns || [];
        const has = (r: string) => cols.some(c => c.roles && c.roles[r]);
        return has("employeeId") && has("managerId");
    }

    private showLanding(show: boolean): void {
        this.landing.style.display = show ? "" : "none";
        (this.svg.node() as SVGSVGElement).style.display = show ? "none" : "";
        if (!show) return;
        while (this.landing.firstChild) this.landing.removeChild(this.landing.firstChild);
        const h = document.createElement("h3");
        h.textContent = "Org Chart";
        const p = document.createElement("p");
        p.textContent = "Add Employee ID and Manager ID to build the chart, then add Name, Job Title, Department and Photo to fill the cards.";
        this.landing.appendChild(h);
        this.landing.appendChild(p);
    }

    private parseRows(dv: DataView): PersonRow[] {
        const table = dv.table!;
        const cols = table.columns;
        const idx = (role: string) => cols.findIndex(c => c.roles && c.roles[role]);
        const iId = idx("employeeId"), iMgr = idx("managerId"), iName = idx("name"),
            iTitle = idx("jobTitle"), iDept = idx("department"), iPhoto = idx("photoUrl");
        const extraIdx = cols.map((c, i) => (c.roles && c.roles["extra"] ? i : -1)).filter(i => i >= 0);

        const fmt = (v: powerbi.PrimitiveValue, ci?: number): string => {
            if (v === null || v === undefined) return "";
            if (typeof v === "number" && !isFinite(v)) return "";
            const col = ci !== undefined ? cols[ci] : undefined;
            if (col && (typeof v === "number" || v instanceof Date)) {
                return valueFormatter.format(v, col.format || undefined);
            }
            return String(v);
        };

        this.selectionIds.clear();
        const rows: PersonRow[] = [];
        table.rows!.forEach((r, i) => {
            const id = fmt(r[iId]);
            if (!id) return;
            rows.push({
                id,
                managerId: iMgr >= 0 ? fmt(r[iMgr]) || null : null,
                name: iName >= 0 ? fmt(r[iName]) : id,
                title: iTitle >= 0 ? fmt(r[iTitle]) : "",
                department: iDept >= 0 ? fmt(r[iDept]) : "",
                photoUrl: iPhoto >= 0 ? fmt(r[iPhoto]) : "",
                extras: extraIdx.map(ci => ({ label: cols[ci].displayName, value: fmt(r[ci], ci) })).filter(e => e.value),
                rowIndex: i
            });
            this.selectionIds.set(i, this.host.createSelectionIdBuilder().withTable(table, i).createSelectionId());
        });
        return rows;
    }

    // ---------------------------------------------------------------- expansion

    private keyOf(n: OrgNode): string {
        if (n.moreOf) return "__more__" + this.keyOf(n.moreOf);
        return n.person ? (cleanKey(n.person.id) as string) : ROOT_KEY;
    }

    private resetExpansion(): void {
        this.expanded.clear();
        this.shown.clear();
        this.pinned.clear();
        this.focusRoot = null;
        this.layoutDirty = true;
        this.setBudgetNote(false);
        if (!this.model) return;
        const depth = this.formattingSettings.layoutCard.initialDepth.value;
        const offset = this.model.syntheticRoot ? 1 : 0;
        const stack: OrgNode[] = [this.model.root];
        while (stack.length) {
            const n = stack.pop()!;
            if (n.depth - offset < depth - 1 || !n.person) {
                this.expanded.add(this.keyOf(n));
                // only descend into reports that will actually be visible on the first page
                const limit = Math.min(n.children.length, PAGE_SIZE);
                for (let i = 0; i < limit; i++) stack.push(n.children[i]);
            }
        }
    }

    /** The reports drawn under a manager: the first page, any pinned search results, then a "+N more" card. */
    private visibleChildren(n: OrgNode): OrgNode[] | null {
        if (n.moreOf || !n.children.length) return null;
        const k = this.keyOf(n);
        if (!this.expanded.has(k)) return null;
        const limit = this.shown.get(k) ?? PAGE_SIZE;
        const kids = n.children;
        if (kids.length <= limit) return kids;
        const list = kids.slice(0, limit);
        const pins = this.pinned.get(k);
        if (pins) pins.forEach(pn => { if (kids.indexOf(pn) >= limit) list.push(pn); });
        const remaining = kids.length - list.length;
        if (remaining > 0) {
            list.push({ person: null, children: [], totalReports: 0, depth: n.depth + 1, parent: n, more: remaining, moreOf: n });
        }
        return list;
    }

    private showMore(parent: OrgNode): void {
        const k = this.keyOf(parent);
        this.shown.set(k, (this.shown.get(k) ?? PAGE_SIZE) + PAGE_SIZE);
        this.render(true, "__more__" + k);
    }

    private expandAll(): void {
        if (!this.model) return;
        // Breadth-first so the top of the org opens first; stop at the render budget.
        let visible = 0;
        let hit = false;
        const queue: OrgNode[] = [this.model.root];
        for (let qi = 0; qi < queue.length; qi++) {
            const n = queue[qi];
            if (!n.children.length) continue;
            const k = this.keyOf(n);
            const limit = this.shown.get(k) ?? PAGE_SIZE;
            const page = Math.min(n.children.length, limit);
            if (visible + page > RENDER_BUDGET && visible > 0) { hit = true; break; }
            this.expanded.add(k);
            visible += page + (n.children.length > limit ? 1 : 0);
            if (n.children.length > limit) hit = true;
            for (let i = 0; i < page; i++) queue.push(n.children[i]);
        }
        this.setBudgetNote(hit);
        this.layoutDirty = true;
        this.render(true);
        this.fit(true);
    }

    private setFocusNote(top: OrgNode, depth: number): void {
        if (!this.infoNote) return;
        this.infoNote.hidden = false;
        this.infoNote.textContent = `Showing the branch from ${top.person?.name || "this manager"} down (${depth.toLocaleString()} levels deep). Click Collapse to return to the top.`;
    }

    private setBudgetNote(on: boolean): void {
        this.budgetHit = on;
        if (!this.infoNote) return;
        this.infoNote.hidden = !on;
        if (on && this.model) {
            this.infoNote.textContent = `Large org (${this.model.count.toLocaleString()} people): showing part of the chart. Use search or "+ more" cards to see everyone.`;
        }
    }

    private toggle(n: OrgNode): void {
        const k = this.keyOf(n);
        if (this.expanded.has(k)) this.expanded.delete(k);
        else this.expanded.add(k);
        this.render(true, k);
    }

    private revealPerson(target: OrgNode): void {
        if (!this.model) return;
        // Very deep match: draw only the branch around the person (a few levels above it).
        let depth = 0;
        for (let a = target.parent ?? null; a; a = a.parent ?? null) depth++;
        this.focusRoot = null;
        let stopAt: OrgNode | null = null;
        if (depth > MAX_REVEAL_DEPTH) {
            let a: OrgNode = target;
            for (let i = 0; i < FOCUS_LEVELS_ABOVE && a.parent && a.parent.person; i++) a = a.parent;
            this.focusRoot = a;
            stopAt = a.parent ?? null;
            this.setFocusNote(a, depth);
        }
        // Walk up the parent links (no recursion, safe for very deep orgs).
        let child: OrgNode = target;
        let p = target.parent ?? null;
        while (p && p !== stopAt) {
            const pk = this.keyOf(p);
            this.expanded.add(pk);
            const limit = this.shown.get(pk) ?? PAGE_SIZE;
            if (p.children.indexOf(child) >= limit) {
                if (!this.pinned.has(pk)) this.pinned.set(pk, new Set());
                this.pinned.get(pk)!.add(child);
            }
            child = p;
            p = p.parent ?? null;
        }
        this.highlightKey = this.keyOf(target);
        this.render(true);
        this.centerOn(this.highlightKey);
    }

    // ---------------------------------------------------------------- render

    private dims() {
        const fs = this.formattingSettings.cardsCard.fontSize.value;
        const k = fs / 12;
        return { w: Math.round(250 * k), h: Math.round(78 * k), fs, k };
    }

    private colorFor(p: PersonRow): string {
        if (this.hc.on) return this.hc.fg;
        const c = this.formattingSettings.colorsCard;
        if (c.colorByDepartment.value && p.department) {
            return this.host.colorPalette.getColor(p.department).value;
        }
        return c.accentColor.value.value;
    }

    private orientationSetting(): string { return String((this.formattingSettings.layoutCard.orientation.value as any).value ?? "auto"); }
    private teamSetting(): string { return String((this.formattingSettings.layoutCard.teamLayout.value as any).value ?? "auto"); }
    private isAuto(): boolean { return this.orientationSetting() === "auto" || this.teamSetting() === "auto"; }

    /** Pick the arrangement: fixed settings are used as-is; "Auto" tries each option and keeps the one with the largest readable fit. */
    private resolveLayout(): LayoutChoice {
        const o = this.orientationSetting(), t = this.teamSetting();
        const verticals = o === "auto" ? [true, false] : [o !== "horizontal"];
        const stackeds = t === "auto" ? [true, false] : [t !== "sideBySide"];
        if (verticals.length * stackeds.length === 1) return { vertical: verticals[0], stacked: stackeds[0] };
        const svgEl = this.svg.node() as SVGSVGElement;
        const vw = +(svgEl?.getAttribute("width") || 0), vh = +(svgEl?.getAttribute("height") || 0);
        let best: LayoutChoice | null = null, bestScore = -1;
        for (const vertical of verticals) {
            for (const stacked of stackeds) {
                if (!vertical && stacked && stackeds.length > 1) continue; // same picture as side by side
                const r = this.computeLayout({ vertical, stacked });
                const b = r.bounds;
                const score = !b || !vw || !vh ? 0 : Math.min(1.1, (vw - 40) / b.width, (vh - 40) / b.height);
                // keep the earlier (preferred) option unless another is clearly better
                if (score > bestScore * 1.02) { best = { vertical, stacked }; bestScore = score; }
            }
        }
        return best ?? { vertical: true, stacked: true };
    }

    /** Lay out the visible chart for one arrangement. */
    private computeLayout(choice: LayoutChoice): LayoutResult {
        const empty: LayoutResult = { placed: [], bounds: null, topPos: null };
        if (!this.model) return empty;
        const { vertical, stacked } = choice;
        const start = this.focusRoot ?? this.model.root;
        const { w, h: ch, fs } = this.dims();
        const L = this.formattingSettings.layoutCard;
        const stackGap = Math.round(10 * fs / 12);

        // Children for the tree layout. In stacked mode, a manager's team members who have no reports of their
        // own are grouped into one placeholder that is later expanded into a stacked list.
        // Long teams wrap into several side-by-side columns of about 10. The tall stack is reserved in the
        // layout with invisible spacer nodes on the levels it covers, so deeper branches never overlap it.
        const colStep = w + stackGap * 3;
        const levelH = vertical ? ch + L.levelSpacing.value : 1;
        const cols = new Map<OrgNode, number>();      // block or spacer -> number of columns
        const spacerLeft = new Map<OrgNode, number>(); // block or spacer -> spacer levels still to add
        const spacer = (owner: OrgNode, left: number, c: number): OrgNode[] | null => {
            if (left <= 0) return null;
            const sp: OrgNode = { person: null, children: [], totalReports: 0, depth: owner.depth + 1, parent: owner };
            cols.set(sp, c); spacerLeft.set(sp, left - 1);
            return [sp];
        };
        const kids = (n: OrgNode): OrgNode[] | null => {
            if (cols.has(n)) return spacer(n, spacerLeft.get(n) ?? 0, cols.get(n)!);
            const vis = this.visibleChildren(n);
            if (!vis || !stacked || !vertical) return vis;
            const leaves = vis.filter(c => c.moreOf || (c.person && c.children.length === 0));
            if (leaves.length < 2) return vis;
            const leafSet = new Set(leaves);
            const others = vis.filter(c => !leafSet.has(c));
            const block: OrgNode = { person: null, children: [], totalReports: 0, depth: n.depth + 1, parent: n, block: leaves };
            const rows = leaves.length <= 12 ? leaves.length : Math.max(10, Math.ceil(Math.sqrt(leaves.length * 2)));
            const c = Math.ceil(leaves.length / rows);
            cols.set(block, c);
            spacerLeft.set(block, Math.ceil((rows * (ch + stackGap)) / levelH) - 1);
            return [block, ...others];
        };

        const root = hierarchy<OrgNode>(start, kids);
        const nodeSize: [number, number] = vertical
            ? [w + L.siblingSpacing.value, ch + L.levelSpacing.value]
            : [ch + L.siblingSpacing.value, w + L.levelSpacing.value];
        const laid = tree<OrgNode>().nodeSize(nodeSize).separation((a, b) => {
            const extra = ((cols.get(a.data) ?? 1) - 1 + (cols.get(b.data) ?? 1) - 1) / 2 * colStep / nodeSize[0];
            return (a.parent === b.parent ? 1 : 1.15) + extra;
        })(root);
        if (!vertical) laid.each(d => { const t = d.x; d.x = d.y; d.y = t; });
        if (this.model.syntheticRoot && !this.focusRoot) {
            const shift = nodeSize[1];
            laid.each(d => { if (vertical) d.y -= shift; else d.x -= shift; });
        }

        const placed: Placed[] = [];
        const byNode = new Map<unknown, Placed>();
        laid.each(d => {
            const parent = d.parent ? byNode.get(d.parent) ?? null : null;
            if (d.data.block) {
                const c = cols.get(d.data) ?? 1, rows = Math.ceil(d.data.block.length / c);
                d.data.block.forEach((m, i) => {
                    const col = Math.floor(i / rows), row = i % rows;
                    placed.push({
                        data: m, depth: d.depth, parent, stacked: true,
                        x: d.x + (col - (c - 1) / 2) * colStep,
                        y: d.y + row * (ch + stackGap)
                    });
                });
            } else if (cols.has(d.data)) {
                // spacer: reserves room only
            } else {
                const p: Placed = { data: d.data, x: d.x, y: d.y, depth: d.depth, parent, stacked: false };
                byNode.set(d, p);
                placed.push(p);
            }
        });

        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        let top: Placed | null = null;
        for (const n of placed) {
            if (!n.data.person && !n.data.moreOf) continue;
            if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
            if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y;
            if (n.data.person && (!top || n.depth < top.depth)) top = n;
        }
        if (!top) return { placed, bounds: null, topPos: null };
        const pad = fs * 1.2; // room for the toggle chip
        const spine = vertical && stacked ? stackGap * 1.4 : 0; // stacked-list spine sits just left of the cards
        const x0 = minX - w / 2 - spine, x1 = maxX + w / 2 + (vertical ? 0 : pad);
        const y0 = minY - ch / 2, y1 = maxY + ch / 2 + (vertical ? pad : 0);
        return { placed, bounds: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, topPos: { x: top.x, y: top.y } };
    }

    private render(animate: boolean, anchorKey?: string): void {
        if (!this.model) return;
        if (this.layoutDirty) { this.layout = this.resolveLayout(); this.layoutDirty = false; }
        const result = this.computeLayout(this.layout);

        const S = this.formattingSettings;
        const { w, h, fs } = this.dims();
        const vertical = this.layout.vertical;
        const stackGap = Math.round(10 * fs / 12);
        const radius = S.cardsCard.cornerRadius.value;
        const showPhoto = S.cardsCard.showPhoto.value;
        const showDept = S.cardsCard.showDepartment.value;
        const showCount = S.cardsCard.showReportCount.value;
        const dur = animate ? 280 : 0;
        const hc = this.hc;
        const cardBg = hc.on ? hc.bg : S.cardsCard.background.value.value;
        const nameColor = hc.on ? hc.fg : S.cardsCard.textColor.value.value;
        const subColor = hc.on ? hc.fg : S.cardsCard.subTextColor.value.value;
        const linkColor = hc.on ? hc.fg : S.colorsCard.linkColor.value.value;

        // keep the toggled node stationary on screen
        let anchorBefore: { x: number; y: number } | null = null;
        if (anchorKey) {
            const prev = this.nodeLayer.selectAll<SVGGElement, PNode>("g.node").filter(d => this.keyOf(d.data) === anchorKey);
            if (!prev.empty()) { const d = prev.datum(); anchorBefore = { x: (d as any)._x ?? d.x, y: (d as any)._y ?? d.y }; }
        }

        const all = result.placed;
        const nodes = all.filter(d => d.data.person);
        const moreNodes = all.filter(d => d.data.moreOf);
        this.bounds = nodes.length ? result.bounds : null;
        this.topPos = nodes.length ? result.topPos : null;
        const links = all.filter(d => d.parent && d.parent.data.person).map(d => ({ source: d.parent!, target: d }));

        // ---- links: orthogonal elbows; stacked team lists hang off a spine beside the cards
        const linkPath = (s: PNode, t: PNode): string => {
            if (t.stacked) {
                const sy = s.y + h / 2, my = sy + S.layoutCard.levelSpacing.value / 2, spineX = t.x - w / 2 - stackGap * 1.4;
                return `M${s.x},${sy}V${my}H${spineX}V${t.y}H${t.x - w / 2}`;
            }
            if (vertical) {
                const sy = s.y + h / 2, ty = t.y - h / 2, my = (sy + ty) / 2;
                return `M${s.x},${sy}V${my}H${t.x}V${ty}`;
            }
            const sx = s.x + w / 2, tx = t.x - w / 2, mx = (sx + tx) / 2;
            return `M${sx},${s.y}H${mx}V${t.y}H${tx}`;
        };

        this.linkLayer.selectAll<SVGPathElement, any>("path.link")
            .data(links, (l: any) => this.keyOf(l.target.data))
            .join(
                enter => enter.append("path").attr("class", "link").attr("d", l => linkPath(l.source, l.source)).attr("opacity", 0),
                update => update,
                exit => exit.remove()
            )
            .attr("fill", "none")
            .attr("stroke", linkColor)
            .attr("stroke-width", S.colorsCard.linkWidth.value)
            .transition().duration(dur)
            .attr("opacity", 1)
            .attr("d", l => linkPath(l.source, l.target));

        // ---- nodes
        const self = this;
        const nodeSel = this.nodeLayer.selectAll<SVGGElement, PNode>("g.node")
            .data(nodes, d => this.keyOf(d.data))
            .join(
                enter => {
                    const g = enter.append("g").attr("class", "node")
                        .attr("tabindex", 0)
                        .attr("role", "treeitem")
                        .attr("opacity", 0)
                        .attr("transform", d => {
                            const p = d.parent && d.parent.data.person ? d.parent : d;
                            return `translate(${(p as any)._x ?? p.x},${(p as any)._y ?? p.y})`;
                        });
                    g.append("rect").attr("class", "card");
                    g.append("rect").attr("class", "accent");
                    g.append("clipPath").attr("class", "avatar-clip").append("circle");
                    g.append("circle").attr("class", "avatar-bg");
                    g.append("text").attr("class", "avatar-initials");
                    g.append("image").attr("class", "avatar-img");
                    g.append("text").attr("class", "name");
                    g.append("text").attr("class", "title");
                    g.append("text").attr("class", "dept");
                    const t = g.append("g").attr("class", "toggle");
                    t.append("rect");
                    t.append("text");
                    return g;
                },
                update => update,
                exit => exit.transition().duration(dur).attr("opacity", 0).remove()
            );

        nodeSel
            .attr("aria-label", d => `${d.data.person!.name}, ${d.data.person!.title}`)
            .attr("aria-expanded", d => (d.data.children.length ? String(this.expanded.has(this.keyOf(d.data))) : null))
            .classed("highlight", d => this.keyOf(d.data) === this.highlightKey);

        nodeSel.select<SVGRectElement>("rect.card")
            .attr("x", -w / 2).attr("y", -h / 2).attr("width", w).attr("height", h)
            .attr("rx", radius).attr("ry", radius)
            .attr("fill", cardBg)
            .attr("stroke", hc.on ? hc.fg : null);

        nodeSel.select<SVGRectElement>("rect.accent")
            .attr("x", -w / 2).attr("y", -h / 2).attr("width", 5).attr("height", h)
            .attr("rx", Math.min(radius, 2.5))
            .attr("fill", d => this.colorFor(d.data.person!));

        const avR = h * 0.30;
        const avX = -w / 2 + 14 + avR;
        const textX = showPhoto ? avX + avR + 10 : -w / 2 + 16;
        const textMax = w / 2 - textX - 8;

        nodeSel.each(function (d) {
            const g = select(this);
            const p = d.data.person!;
            const color = self.colorFor(p);
            const clipId = "clip-" + self.safeId(self.keyOf(d.data));

            g.select("clipPath").attr("id", clipId).select("circle").attr("cx", avX).attr("cy", 0).attr("r", avR);
            g.select("circle.avatar-bg").attr("cx", avX).attr("cy", 0).attr("r", avR)
                .attr("fill", color).attr("display", showPhoto ? null : "none");
            g.select("text.avatar-initials").attr("x", avX).attr("y", 0).attr("dy", "0.35em")
                .attr("text-anchor", "middle").attr("font-size", fs * 1.05).attr("fill", self.hc.on ? self.hc.bg : "#fff")
                .attr("display", showPhoto ? null : "none")
                .text(initials(p.name));

            const img = g.select<SVGImageElement>("image.avatar-img");
            const url = self.safeImageUrl(p.photoUrl);
            if (showPhoto && url) {
                if (img.attr("href") !== url) {
                    img.attr("display", null).attr("href", url)
                        .on("error", function () { select(this).attr("display", "none"); });
                }
                img.attr("x", avX - avR).attr("y", -avR).attr("width", avR * 2).attr("height", avR * 2)
                    .attr("preserveAspectRatio", "xMidYMid slice").attr("clip-path", `url(#${clipId})`);
            } else {
                img.attr("display", "none").attr("href", null);
            }

            const lines = showDept && p.department ? [-0.62, 0.38, 1.3] : [-0.35, 0.75];
            g.select("text.name").attr("font-size", fs * 1.08).attr("font-weight", 600).attr("fill", nameColor);
            g.select("text.title").attr("font-size", fs * 0.92).attr("fill", subColor);
            g.select("text.dept").attr("font-size", fs * 0.8).attr("fill", color).attr("font-weight", 600);
            self.fitText(g.select<SVGTextElement>("text.name"), p.name, textX, lines[0] * fs * 1.25, textMax, fs * 1.08, 600);
            self.fitText(g.select<SVGTextElement>("text.title"), p.title, textX, lines[1] * fs * 1.25, textMax, fs * 0.92, 400);
            self.fitText(g.select<SVGTextElement>("text.dept"), showDept ? p.department : "", textX, (lines[2] ?? 0) * fs * 1.25, textMax, fs * 0.8, 600);

            // toggle / report-count chip
            const hasKids = d.data.children.length > 0;
            const isOpen = self.expanded.has(self.keyOf(d.data));
            const label = !hasKids ? "" : isOpen ? "−" : showCount ? `${d.data.children.length}` : "+";
            const tg = g.select<SVGGElement>("g.toggle").attr("display", hasKids ? null : "none");
            const chipW = Math.max(22, label.length * fs * 0.7 + 14), chipH = fs * 1.6;
            const cx = vertical ? 0 : w / 2;
            const cy = vertical ? h / 2 : 0;
            tg.attr("transform", `translate(${cx},${cy})`)
                .attr("tabindex", -1)
                .attr("aria-label", isOpen ? "Collapse" : `Expand ${d.data.children.length} direct reports`);
            tg.select("rect").attr("x", -chipW / 2).attr("y", -chipH / 2).attr("width", chipW).attr("height", chipH)
                .attr("rx", chipH / 2).attr("fill", isOpen ? cardBg : color)
                .attr("stroke", color).attr("stroke-width", 1.2);
            tg.select("text").attr("text-anchor", "middle").attr("dy", "0.35em").attr("font-size", fs * 0.85)
                .attr("font-weight", 700).attr("fill", isOpen ? color : (hc.on ? hc.bg : "#fff")).text(label);
            tg.on("click", (event: MouseEvent) => { event.stopPropagation(); self.toggle(d.data); });
        });

        nodeSel
            .on("click", (event: MouseEvent, d) => this.onSelect(d, event.ctrlKey || event.metaKey))
            .on("dblclick", (event: MouseEvent, d) => { event.stopPropagation(); if (d.data.children.length) this.toggle(d.data); })
            .on("keydown", (event: KeyboardEvent, d) => {
                if (event.key === "Enter") { this.onSelect(d, event.ctrlKey || event.metaKey); event.preventDefault(); }
                else if (event.key === " " && d.data.children.length) { this.toggle(d.data); event.preventDefault(); }
            })
            .on("contextmenu", (event: MouseEvent, d) => {
                const id = this.selectionIds.get(d.data.person!.rowIndex);
                this.selectionManager.showContextMenu(id || {}, { x: event.clientX, y: event.clientY });
                event.preventDefault();
                event.stopPropagation();
            })
            .on("mouseover mousemove", (event: MouseEvent, d) => {
                this.host.tooltipService.show({
                    coordinates: [event.clientX, event.clientY],
                    isTouchEvent: false,
                    identities: [this.selectionIds.get(d.data.person!.rowIndex)].filter(Boolean) as ISelectionId[],
                    dataItems: this.tooltipItems(d.data)
                });
            })
            .on("mouseout", () => this.host.tooltipService.hide({ immediately: true, isTouchEvent: false }));

        nodeSel.transition().duration(dur)
            .attr("opacity", 1)
            .attr("transform", d => `translate(${d.x},${d.y})`);

        // ---- "+N more" cards
        const moreSel = this.nodeLayer.selectAll<SVGGElement, PNode>("g.more")
            .data(moreNodes, d => this.keyOf(d.data))
            .join(
                enter => {
                    const g = enter.append("g").attr("class", "more").attr("tabindex", 0).attr("role", "button")
                        .attr("opacity", 0)
                        .attr("transform", d => `translate(${d.x},${d.y})`);
                    g.append("rect").attr("class", "more-card");
                    g.append("text").attr("class", "more-count");
                    g.append("text").attr("class", "more-hint");
                    return g;
                },
                update => update,
                exit => exit.remove()
            );
        moreSel.attr("aria-label", d => `Show ${Math.min(PAGE_SIZE, d.data.more!)} more of ${d.data.more!.toLocaleString()} hidden direct reports`);
        moreSel.select("rect.more-card")
            .attr("x", -w / 2).attr("y", -h / 2).attr("width", w).attr("height", h)
            .attr("rx", radius).attr("ry", radius)
            .attr("fill", cardBg).attr("stroke", hc.on ? hc.fg : "#9AA4B2").attr("stroke-dasharray", "5 4");
        moreSel.select("text.more-count").attr("x", 0).attr("y", -fs * 0.35).attr("dy", "0.35em").attr("text-anchor", "middle")
            .attr("font-size", fs * 1.15).attr("font-weight", 700).attr("fill", nameColor)
            .text(d => `+ ${d.data.more!.toLocaleString()} more`);
        moreSel.select("text.more-hint").attr("x", 0).attr("y", fs * 0.95).attr("dy", "0.35em").attr("text-anchor", "middle")
            .attr("font-size", fs * 0.85).attr("fill", subColor)
            .text(d => `Click to show the next ${Math.min(PAGE_SIZE, d.data.more!)}`);
        moreSel
            .on("click", (event: MouseEvent, d) => { event.stopPropagation(); this.showMore(d.data.moreOf!); })
            .on("keydown", (event: KeyboardEvent, d) => {
                if (event.key === "Enter" || event.key === " ") { this.showMore(d.data.moreOf!); event.preventDefault(); }
            });
        moreSel.transition().duration(dur)
            .attr("opacity", 1)
            .attr("transform", d => `translate(${d.x},${d.y})`);

        nodeSel.each(d => { (d as any)._x = d.x; (d as any)._y = d.y; });

        // keep the anchor node still by shifting the zoom transform
        if (anchorKey && anchorBefore) {
            const now = nodes.find(n => this.keyOf(n.data) === anchorKey);
            if (now) {
                const dx = anchorBefore.x - now.x, dy = anchorBefore.y - now.y;
                if (dx || dy) {
                    this.svg.transition().duration(dur).call(this.zoomBehavior.translateBy as any, dx, dy);
                }
            }
        }

        this.applySelectionStyles();
    }

    private tooltipItems(n: OrgNode): VisualTooltipDataItem[] {
        const p = n.person!;
        const items: VisualTooltipDataItem[] = [{ displayName: "Name", value: p.name }];
        if (p.title) items.push({ displayName: "Title", value: p.title });
        if (p.department) items.push({ displayName: "Department", value: p.department, color: this.colorFor(p) });
        if (n.children.length) {
            items.push({ displayName: "Direct reports", value: String(n.children.length) });
            items.push({ displayName: "Total org", value: String(n.totalReports) });
        }
        p.extras.forEach(e => items.push({ displayName: e.label, value: e.value }));
        return items;
    }

    private onSelect(d: PNode, multi: boolean): void {
        if (!this.allowInteractions) return;
        const id = this.selectionIds.get(d.data.person!.rowIndex);
        if (!id) return;
        this.selectionManager.select(id, multi).then(() => this.applySelectionStyles());
    }

    private applySelectionStyles(): void {
        const ids = this.selectionManager.getSelectionIds() as ISelectionId[];
        const any = ids.length > 0;
        this.nodeLayer.selectAll<SVGGElement, PNode>("g.node")
            .classed("dimmed", d => {
                if (!any) return false;
                const id = this.selectionIds.get(d.data.person!.rowIndex);
                return !id || !ids.some(s => s.equals(id));
            });
    }

    // ---------------------------------------------------------------- view helpers

    private fit(animate: boolean): void {
        const svgEl = this.svg.node() as SVGSVGElement;
        const box = this.bounds;
        if (!svgEl || !box) return;
        const vw = +svgEl.getAttribute("width")!, vh = +svgEl.getAttribute("height")!;
        if (!box.width || !box.height || !vw || !vh) return;

        const pad = 20;
        const fitScale = Math.min(1.1, (vw - pad * 2) / box.width, (vh - pad * 2) / box.height);
        const scale = Math.max(fitScale, MIN_FIT_SCALE);
        const vertical = this.layout.vertical;
        let tx: number, ty: number;
        if (fitScale < MIN_FIT_SCALE && this.topPos) {
            // Too big to show legibly: keep a readable zoom and start at the top of the org.
            const { w, h } = this.dims();
            if (vertical) { tx = vw / 2 - scale * this.topPos.x; ty = pad - scale * (this.topPos.y - h / 2); }
            else { tx = pad - scale * (this.topPos.x - w / 2); ty = vh / 2 - scale * this.topPos.y; }
        } else {
            tx = vertical || box.width * scale > vw - pad * 2
                ? vw / 2 - scale * (box.x + box.width / 2)
                : pad - scale * box.x;
            // top-aligned for top-down charts, vertically centred for left-to-right
            ty = vertical ? pad - scale * box.y : vh / 2 - scale * (box.y + box.height / 2);
        }
        const t = zoomIdentity.translate(tx, ty).scale(scale);
        const target = animate ? this.svg.transition().duration(350) : this.svg;
        (target as any).call(this.zoomBehavior.transform, t);
    }

    private centerOn(key: string): void {
        const g = this.nodeLayer.selectAll<SVGGElement, PNode>("g.node").filter(d => this.keyOf(d.data) === key);
        if (g.empty()) return;
        const d = g.datum();
        const svgEl = this.svg.node() as SVGSVGElement;
        const vw = +svgEl.getAttribute("width")!, vh = +svgEl.getAttribute("height")!;
        const k = Math.max(0.8, (svgEl as any).__zoom?.k || 1);
        const t = zoomIdentity.translate(vw / 2 - k * d.x, vh / 2 - k * d.y).scale(k);
        this.svg.transition().duration(450).call(this.zoomBehavior.transform as any, t);
        (g.node() as SVGGElement).focus();
    }

    /** Truncate with an ellipsis using canvas text metrics (no layout reflow, fast for thousands of cards). */
    private fitText(sel: Selection<SVGTextElement, unknown, null, undefined>, text: string, x: number, y: number, max: number,
                    size: number, weight: number) {
        sel.attr("x", x).attr("y", y).attr("dy", "0.35em");
        const t = text || "";
        if (!this.measureCtx) {
            this.measureCtx = document.createElement("canvas").getContext("2d");
            try { this.fontFamily = getComputedStyle(this.container).fontFamily || this.fontFamily; } catch { /* keep default */ }
        }
        const ctx = this.measureCtx;
        if (!ctx || !t) { sel.text(t); return sel; }
        ctx.font = `${weight} ${size}px ${this.fontFamily}`;
        if (ctx.measureText(t).width <= max) { sel.text(t); return sel; }
        let lo = 0, hi = t.length;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (ctx.measureText(t.slice(0, mid) + "…").width <= max) lo = mid; else hi = mid - 1;
        }
        sel.text(t.slice(0, lo).trimEnd() + "…");
        return sel;
    }

    private safeId(key: string): string {
        return key.replace(/[^a-zA-Z0-9_-]/g, "_");
    }

    private safeImageUrl(url: string): string | null {
        // Certified visuals may not load external resources, so only embedded raster images are drawn.
        const u = (url || "").trim();
        if (/^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(u)) return u.replace(/\s+/g, "");
        return null;
    }
}
