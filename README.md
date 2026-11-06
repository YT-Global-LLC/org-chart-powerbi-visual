# Org Chart by YT Global — Power BI visual

An interactive, multilevel organization chart for Microsoft Power BI, built from any table with
**Employee ID** and **Manager ID** columns (for example a Microsoft SharePoint list, Excel or a database).

- Unlimited levels; expand and collapse any team (collapsed managers show their team size)
- Search by name, title or department, which opens the branch and highlights the person
- Expand all, Collapse and Fit buttons; zoom and pan
- Cards with embedded photo or initials, name, title and department, colored by department
- Cross-filtering, multi-select, context menu, tooltips with model format strings
- Auto layout picks the arrangement with the largest readable cards for the visual's size
- Stacked team lists: people with no reports are listed in compact columns under their manager instead of one long row
- Top-to-bottom or left-to-right layout; card, color and spacing options in the Format pane
- Flags data problems (missing managers, duplicate IDs, reporting loops) instead of breaking
- Keyboard navigation and high-contrast support; up to 30,000 rows
- Stays responsive with very large or flat orgs: direct reports load in pages of 50 ("+ N more" cards),
  Expand all stops at ~1,500 cards, and search reveals anyone without drawing the whole org

**Setup guide for customers:** https://ytgllc.com/org-chart-support.html

## Privacy and security

The visual makes **no network requests**: `capabilities.json` declares no `WebAccess` privilege, and the
code uses no `fetch`, `XMLHttpRequest`, `eval` or `innerHTML`. All text is written with `textContent` or
SVG text nodes. Photos are drawn only from `data:image/(png|jpeg|gif|webp);base64` values already in the
report's data. Privacy policy: https://ytgllc.com/org-chart-privacy.html

## Build

Requirements: Node.js 18+ and `powerbi-visuals-tools` 7.x.

```bash
npm install -g powerbi-visuals-tools
npm install
npx eslint .                         # 0 errors
npm audit                            # 0 vulnerabilities
pbiviz package --certification-audit # writes dist/*.pbiviz
```

| | |
|---|---|
| Visual GUID | `spOrgChartYTG7C41E0B2A9D84F3C9F12` |
| Version | 1.2.0.0 |
| API version | 5.11.1 |

## Repository layout

| Path | Contents |
|---|---|
| `src/visual.ts` | Rendering (d3), zoom/pan, search, selection, tooltips, rendering events |
| `src/orgModel.ts` | Builds the hierarchy from flat rows; handles duplicates, missing managers and cycles |
| `src/settings.ts` | Format pane model |
| `style/visual.less` | Styles |
| `capabilities.json` | Data roles, format objects, (empty) privileges |
| `setup/` | Customer setup files: SharePoint list script, Power Query, CSV template, sample data |

## Testing

No accounts, license keys or credentials are needed; the visual is free with no in-app purchases.
Load `setup/sample-org.csv` with **Enter data**, bind Employee ID and Manager ID (plus Name, Job Title and
Department), then try the search box, expand/collapse chips, Expand all / Collapse / Fit, and click a card
to cross-filter.

## Changelog

- **1.2.0.0**: Layout options. New *Auto (best fit)* orientation (default) and *Team members (no reports)* setting:
  stacked list, side by side or auto (default). Large teams wrap into columns of about 10. Auto re-evaluates when
  the visual is resized. Names sort in natural order (Employee 2 before Employee 10).

- **1.1.1.0**: Large-data performance. Paged direct reports with "+ N more" cards, render budget for
  Expand all, canvas-based text truncation (no layout reflow), iterative traversal (safe for very deep
  orgs), branch focus for very deep search results, minimum readable zoom on Fit, capped warning list.
  Tested with 30,000 rows as flat, single-manager, unmatched-manager, wide, balanced and 30,000-level chains.
- **1.1.0.0**: First AppSource submission.

## License

Copyright © 2026 YT Global LLC. All rights reserved; see [LICENSE](LICENSE).
Support: appsupport@ytgllc.com
