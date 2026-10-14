"use strict";

import powerbi from "powerbi-visuals-api";
import { FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";
import { select, Selection } from "d3-selection";
import { hierarchy, tree, HierarchyPointNode } from "d3-hierarchy";
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

type PNode = HierarchyPointNode<OrgNode>;

const ROOT_KEY = "__synthetic_root__";

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
    private dataSignature = "";
    private lastInitialDepth = -1;
    private highlightKey: string | null = null;
    private width = 0;
    private height = 0;
    private didInitialFit = false;
    private bounds: { x: number; y: number; width: number; height: number } | null = null;

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
        const walk = (n: OrgNode) => {
            if (hits.length >= 12) return;
            const p = n.person;
            if (p && (p.name.toLowerCase().includes(q) || p.title.toLowerCase().includes(q) || p.department.toLowerCase().includes(q))) hits.push(n);
            n.children.forEach(walk);
        };
        walk(this.model.root);

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
        if (onlyResize && this.model) return;

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

        const w = this.model.warnings;
        this.warnBadge.hidden = w.length === 0;
        this.warnBadge.textContent = `⚠ ${w.length}`;
        this.warnBadge.title = w.slice(0, 25).join("\n") + (w.length > 25 ? `\n…and ${w.length - 25} more` : "");

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
        return n.person ? (cleanKey(n.person.id) as string) : ROOT_KEY;
    }

    private resetExpansion(): void {
        this.expanded.clear();
        if (!this.model) return;
        const depth = this.formattingSettings.layoutCard.initialDepth.value;
        const offset = this.model.syntheticRoot ? 1 : 0;
        const walk = (n: OrgNode) => {
            if (n.depth - offset < depth - 1 || !n.person) {
                this.expanded.add(this.keyOf(n));
                n.children.forEach(walk);
            }
        };
        walk(this.model.root);
    }

    private expandAll(): void {
        if (!this.model) return;
        const walk = (n: OrgNode) => { this.expanded.add(this.keyOf(n)); n.children.forEach(walk); };
        walk(this.model.root);
        this.render(true);
        this.fit(true);
    }

    private toggle(n: OrgNode): void {
        const k = this.keyOf(n);
        if (this.expanded.has(k)) this.expanded.delete(k);
        else this.expanded.add(k);
        this.render(true, k);
    }

    private revealPerson(target: OrgNode): void {
        if (!this.model) return;
        // find path root -> target
        const path: OrgNode[] = [];
        const find = (n: OrgNode): boolean => {
            path.push(n);
            if (n === target) return true;
            for (const c of n.children) if (find(c)) return true;
            path.pop();
            return false;
        };
        find(this.model.root);
        path.slice(0, -1).forEach(n => this.expanded.add(this.keyOf(n)));
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

    private layoutTree(): PNode | null {
        if (!this.model) return null;
        const h = hierarchy<OrgNode>(this.model.root, n => (this.expanded.has(this.keyOf(n)) ? n.children : null));
        const { w, h: ch } = this.dims();
        const L = this.formattingSettings.layoutCard;
        const vertical = (L.orientation.value as any).value !== "horizontal";
        const nodeSize: [number, number] = vertical
            ? [w + L.siblingSpacing.value, ch + L.levelSpacing.value]
            : [ch + L.siblingSpacing.value, w + L.levelSpacing.value];
        const laid = tree<OrgNode>().nodeSize(nodeSize).separation((a, b) => (a.parent === b.parent ? 1 : 1.15))(h);
        if (!vertical) laid.each(d => { const t = d.x; d.x = d.y; d.y = t; });
        // If synthetic root is hidden, pull everything up one level.
        if (this.model.syntheticRoot) {
            const shift = nodeSize[1];
            laid.each(d => { if (vertical) d.y -= shift; else d.x -= shift; });
        }
        return laid;
    }

    private render(animate: boolean, anchorKey?: string): void {
        const laid = this.layoutTree();
        if (!laid) return;

        const S = this.formattingSettings;
        const { w, h, fs } = this.dims();
        const vertical = (S.layoutCard.orientation.value as any).value !== "horizontal";
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

        const nodes = laid.descendants().filter(d => d.data.person);
        if (nodes.length) {
            const pad = fs * 1.2; // room for the toggle chip
            const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
            const x0 = Math.min(...xs) - w / 2, x1 = Math.max(...xs) + w / 2 + (vertical ? 0 : pad);
            const y0 = Math.min(...ys) - h / 2, y1 = Math.max(...ys) + h / 2 + (vertical ? pad : 0);
            this.bounds = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
        } else {
            this.bounds = null;
        }
        const links = laid.links().filter(l => l.source.data.person);

        // ---- links (orthogonal elbows)
        const linkPath = (s: PNode, t: PNode): string => {
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
            self.fitText(g.select<SVGTextElement>("text.name"), p.name, textX, lines[0] * fs * 1.25, textMax);
            self.fitText(g.select<SVGTextElement>("text.title"), p.title, textX, lines[1] * fs * 1.25, textMax);
            self.fitText(g.select<SVGTextElement>("text.dept"), showDept ? p.department : "", textX, (lines[2] ?? 0) * fs * 1.25, textMax);

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
        const scale = Math.min(1.1, (vw - pad * 2) / box.width, (vh - pad * 2) / box.height);
        const vertical = (this.formattingSettings.layoutCard.orientation.value as any).value !== "horizontal";
        const tx = vertical || box.width * scale > vw - pad * 2
            ? vw / 2 - scale * (box.x + box.width / 2)
            : pad - scale * box.x;
        // top-aligned for top-down charts, vertically centred for left-to-right
        const ty = vertical ? pad - scale * box.y : vh / 2 - scale * (box.y + box.height / 2);
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

    private fitText(sel: Selection<SVGTextElement, unknown, null, undefined>, text: string, x: number, y: number, max: number) {
        sel.attr("x", x).attr("y", y).attr("dy", "0.35em").text(text || "");
        const el = sel.node();
        if (!el || !text) return sel;
        try {
            if (el.getComputedTextLength() <= max) return sel;
            let lo = 0, hi = text.length;
            while (lo < hi) {
                const mid = Math.ceil((lo + hi) / 2);
                el.textContent = text.slice(0, mid) + "…";
                if (el.getComputedTextLength() <= max) lo = mid; else hi = mid - 1;
            }
            el.textContent = text.slice(0, lo).trimEnd() + "…";
        } catch { /* not rendered yet (hidden visual) – leave full text */ }
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
