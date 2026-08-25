# Design QA

## Evidence

- Source visual truth: `.tmp/redesign-selected-aligned-limits.png`
- Browser-rendered implementation: `.tmp/popup-implementation-dark-v4.png`
- Combined comparison: `.tmp/design-qa-comparison-v4.png`
- Expanded disclosure evidence: `.tmp/popup-other-limits-open.png`
- Viewport: 360 x 600 CSS px, device scale factor 1, dark color scheme
- Source pixels: 969 x 1622, normalized to 360 x 600 in the comparison surface
- Implementation pixels: 360 x 600
- State: signed in, Pro plan visible, unified `Usage visible in ChatGPT` status, 5h unavailable, weekly 43%, Credits 0, one full reset expiring 21 de septiembre, Other limits and Diagnostics collapsed

## Full-view comparison

The latest browser capture preserves the selected hierarchy and compact rhythm: continuous dark surface, inline status and actions, two-column account metadata, undivided primary limits band, collapsed Other limits, split totals, collapsed Diagnostics, and local-only footer. The 5h and Weekly titles share the same top baseline; the unavailable 5h value uses one dash and no redundant message.

## Focused interaction evidence

A separate crop was not needed because the 360 px implementation remains legible at 1:1 in the combined comparison. The expanded-state screenshot verifies that Other limits opens as a native disclosure, shows only the two Spark limits, preserves single-dash empty states, and remains scrollable within the fixed popup viewport.

Primary interactions tested in the browser:

- Other limits opened and closed successfully.
- Diagnostics opened successfully.
- Refresh completed and returned to enabled text `Refresh`.
- The compact paired layout loaded directly, with no mode toggle or stored preference.
- Browser page errors: none.
- Browser console errors: none.

## Findings

- No remaining P0, P1, or P2 findings.
- P3: the generated reference includes small decorative action/account icons. The implementation keeps the existing dependency-free text controls; labels and native affordances remain clear, so this does not block fidelity or use.
- P3: the Spanish full-reset label wraps at the real 360 px viewport. This preserves readable type and the complete source label instead of shrinking or truncating it.
- Accepted product override: after the visual selection, the user replaced the reference's redundant two-part status with the single phrase `Usage visible in ChatGPT`.
- Accepted product override: the compact layout is now the only layout, so its toggle and preference plumbing were removed.
- Accepted product override: the redundant `ChatGPT` heading above Login and Plan was removed.

## Comparison history

### Iteration 1

- P2: `Visit Analytics` wrapped to two lines at 360 px.
- P2: `Detected signed in` wrapped inside the Login column.
- Fix: reduced only action/account metadata type sizes, tightened gaps and button width, and kept action copy on one line.
- Post-fix evidence: `.tmp/popup-implementation-dark-v2.png` and `.tmp/design-qa-comparison-v2.png` show both strings on one line without overlap or clipping.

## Required fidelity surfaces

- Fonts and typography: system UI family matches the product source; hierarchy, weights, wrapping, and small metadata remain legible at the real popup size.
- Spacing and layout rhythm: continuous sections, subtle dividers, aligned primary-limit headings, and compact vertical flow match the selected direction.
- Colors and visual tokens: near-black base, slightly raised primary-limit surface, off-white text, muted blue-gray metadata, cyan status/actions, and amber weekly indicator match the reference semantics.
- Image quality and asset fidelity: no raster imagery is required. The existing dynamic percentage indicator remains code-native and sharp at device scale 1.
- Copy and content: selected labels, values, reset/expiry copy, unified visible-status message, status age placement, and local-only footer are preserved; unavailable metrics use one dash only.

## Implementation checklist

- [x] Preserve existing data collection and refresh behavior.
- [x] Keep Last refresh immediately left of Refresh.
- [x] Align 5h and Weekly headings at the top without a divider.
- [x] Use one dash for unavailable metrics.
- [x] Make Other limits collapsed by default and interactive.
- [x] Keep Diagnostics interactive.
- [x] Use the compact layout directly without a toggle.
- [x] Remove the redundant ChatGPT account heading.
- [x] Pass syntax checks and the complete automated test suite.

final result: passed
