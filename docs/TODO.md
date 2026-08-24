# vscode-fcs-viewer

> vscode extension to inspect flow cytometry data directly in vscode

Objective: EasyFlowQ-inspired fcs viewer, but with card-based interface

## MVP

- [x] open FCS files in vscode / add more fcs files to viewer workspace
- [x] view fcs meta data and summary statistics
- [x] view fcs in data table (rows are cells, columns are markers)
- [x] create plots in a tile/card based layout (e.g., similar to MLFlows metrics overview) to visualize FCS data
    - [x] bivariate dot plots (configurable axis) with optional density overlay
    - [x] UMAP plots *(t-SNE evaluated and rejected — see Feedback V4)*
    - [x] single channel histograms
- [x] apply compensation (e.g., if provided in FCS metadata)
- [x] apply data transforms, like linear, log or arcsinh with cofactor
- [x] export plots to png or copy to clipboard *(PNG via the plot's camera button; clipboard copy not wired up)*

## Feedback V1 — addressed

- [x] UI froze for ~30s when adding a sample, and scatter plots showed
      "WebGL is not supported" above 10,000 events. Same root cause: WebGL is
      unavailable in some VS Code windows, and every failed context attempt
      blocks the renderer. Now probed once, with an SVG fallback capped at 5,000
      points and a notice. A second, independent bug made every sample load
      render each card twice; fixed by memoising `rawColumn`.
- [x] Table headers show both `$PnS` and `$PnN`; the "show all events" toggle is
      gone and the table always follows the global subsample.
- [x] Channel matching is exact: index, `$PnN` and `$PnS` must all agree. No
      case folding or punctuation stripping.
- [x] Transform is a dropdown with a conditional "Transform parameters" group —
      cofactor for arsinh, decades for log, nothing for linear. Range stays a
      shared control since it applies to every transform.
- [x] `arsinh`, not `arcsinh`.
- [x] Removed: table precision, the global "new cards" transform and "apply to
      all". New cards pick their transform per channel — linear for FSC/SSC and
      Time, arsinh for everything else. "Copy view" is now "Copy to clipboard";
      column presets kept under a "Show columns:" label.
- [x] A "+ Add plot" tile at the end of the card grid.

## Feedback V2 — addressed

- [x] The freeze was payload size, not CPU. The host was posting the whole 31 MB
      event matrix; in a dev container that crosses the remote tunnel. Only the
      subsample is sent now — 1.09 MB at the 5,000 default, gathered in 4 ms.
      (On threads: the extension host is already a separate process from the
      webview renderer, so sending less was the lever, not concurrency.)
- [x] Growing the subsample re-fetches; shrinking is served from the slice
      already in memory, with no round-trip at all.
- [x] Table numbers are exactly two decimals.
- [x] Default subsample is 5,000.
- [x] Log is the GatingML 2.0 flog, `(1/M)*log10(x/T) + 1`, with M and T
      editable and defaulting to 1.
- [x] `d3-axis`, `d3-scale` and `d3-selection` are gone — they were only used by
      the SVG axis overlay that Plotly replaced. `d3-array`, `d3-format` and
      `d3-scale-chromatic` are still used, for tick generation, number
      formatting and the colormaps.

## Feedback V3 — addressed

- [x] The remaining freeze was React's **development** runtime, not our code.
      React 19 serialises component props for its Performance track, and those
      props include the typed arrays handed to Plotly. Measured on the 146k
      file with six cards: 2,054 ms of blocked main thread, versus 0 ms with
      the production runtime. The webview now builds with production React even
      for debug builds; pass `--react-dev` to get the warnings back.
- [x] Plot draws are also queued one per frame, so a grid paints progressively
      instead of in one blocking task. This matters where WebGL is unavailable
      and scatter falls back to SVG: eight cards went from a single 398 ms task
      to seven of at most 64 ms.
- [x] M and T could not do anything, because flog is affine in log10: on a
      percentile-derived range they shifted the values, the range and the ticks
      by the same amount and the picture never moved. A log axis now takes its
      range from the parameters, as GatingML intends — flog maps `[T*10^-M, T]`
      onto `[0, 1]` — and M and T are seeded from the channel rather than from
      the spec's M = T = 1, which would frame every axis on 0.1 to 1.
- [x] Status messages moved to a bottom bar of constant height, with details in
      a drawer. They used to sit between the tabs and the view, where they
      pushed the plots down by a different amount for every sample.
- [x] The header's "+ Plot" button is gone; the "+ Add plot" tile is the only
      way in, and it only exists on the Plots tab.
- [x] New "Contour" plot type, Plotly's `histogram2dcontour`, with colormap,
      level count, shading and an optional event underlay. Plot type is a
      dropdown and "Dot plot" is now "Scatter".
- [x] Commands are all under the "FCS Viewer" category.
- [x] Named viewer workspaces: save the focused tab's samples and cards under a
      name, reopen one in a tab of its own, delete one. Separate from the
      automatic per-tab memory, which is what "Discard Remembered Samples"
      clears.
- [x] The last three d3 packages are gone. `ticks` and the number formats are
      about 120 lines in `src/common`, and the colormaps were only ever twelve
      stops each, which are now baked in.

## Code review — addressed

All 25 findings in [REVIEW.md](REVIEW.md) were verified against current code
before acting; none was inaccurate and none was already fixed.

- [x] **C1** Named workspaces silently discarded the card layout. Neither half
      of the UI round-trip was connected: the host never stored the webview's
      blob, and never posted `host/restoreState` — even though the webview's
      handler for it was complete. Both wired, with a regression test that
      fails without them.
- [x] **C2** `UI_STATE_KEY` was a single global memento key in an otherwise
      per-panel design, and nothing ever read it. Gone.
- [x] **C3** Matrix-cache pins were taken on every activation and released only
      when the tab closed, so `CACHE_SIZE = 3` meant nothing after three
      samples — ten CyTOF files is ~310 MB. The outgoing sample is unpinned,
      and only resident pins count toward the eviction ceiling.
- [x] **C4** `context.subscriptions` grew by two entries per file opened, and
      the ack log grew per delivered slice. Both bounded.
- [x] **H1** `fcs/sample` had no staleness guard, so two quick sample switches
      could leave the webview showing one sample and the host believing
      another. Activations are numbered and superseded ones stop before
      posting; the id is echoed so the reducer can drop a late payload.
- [x] **H2** `buildPayload` pushed warnings onto metadata owned by the cache
      and shared across tabs, so they accumulated on every re-activation.
- [x] **H3** `requestedN` was latched before the active-sample check.
- [x] **H4** Contour cards' Y channel was left out of the mapping report, so a
      missing channel greyed the card out while the status bar said all was
      well.
- [x] **H5** `FCS_TOO_LARGE` pointed at a setting that does not control the
      limit it hit.
- [x] **H6** Cancellation missed the typed-array fast path — the one the 31 MB
      file takes — so Cancel did nothing on exactly the files worth cancelling.
      Re-slices are now cancellable too, and a newer request cancels the one
      in flight.
- [x] **H7** ESLint now runs typescript-eslint `recommended`,
      `eslint-plugin-react-hooks` and `no-unused-vars`. It immediately found
      two dead imports and two genuine `setState`-in-effect patterns.
- [x] **M1** Two diverged copies of the default-cofactor heuristic; the better
      one was the dead one. Deleted the private copy.
- [x] **M2** Dead exports removed. `fcs/progress` was kept and *wired up*
      instead: it is the only thing that sets `status: 'loading'`, so the
      sidebar spinner and the status bar had never once appeared.
- [x] **M3/M5** Split out `openQueue`, `sliceBudget`, `panelManager` and
      `panelMessages`; `matrixCache` is a class owned by `activate()` rather
      than module globals. The slice budget is now unit-testable without a
      VS Code host, and `SampleRegistry` takes its cache as a constructor
      argument, which is what makes a cache test possible at all.
- [x] **M4/M6/M7/M8/M9** `enqueue` moved to its own module; the CSP nonce comes
      from a CSPRNG; inbound messages are validated and the protocol version is
      actually compared; `hydrate` stats files concurrently; `SampleRegistry`
      indexes URIs instead of scanning.
- [x] **M11** One shared `until()` helper instead of four copies.
- [x] **L1** "Copy to clipboard" copied only the rendered row window, so the
      result depended on window height. It copies the whole subsample and the
      button says how many rows.
- [x] **L3** Per-kind card patch actions; the `as CardConfig` cast is gone.
- [x] **L4** Card ids come from `crypto.randomUUID()`.
- [x] **L6** CI runs type-check, lint, unit and integration tests. The awkward
      parser cases that only the gitignored 40 MB files used to cover are now
      synthetic fixtures.
- [x] Extra: DATA segment offsets. Files that declare the end offset
      exclusively (flowkit's `ignore_offset_error` case) were already read
      correctly, but reported a misleading truncation warning; the mirror bug,
      an end one byte short, silently dropped the last event. One rule now
      repairs both, bounded by `$TOT` and the file length. `$ENDDATA` is also
      compared against the HEADER, which it never was.

### Declined, deliberately

- **C5** (publishing metadata) — needs a marketplace publisher id, a repository
  URL and a licence choice that are not mine to invent. Note that
  `src/test/integration/extension.test.ts` and `openRedirect.test.ts` hardcode
  `undefined_publisher.vscode-fcs-viewer`, so both need updating in the same
  change.
- **L2** (sentinel `'auto'` strings in unions) — the review calls it "entirely
  taste"; a discriminated union would churn the persistence and migration
  layer for no behavioural gain.
- **M10** (debug commands ship in the package) — the trade-off is already
  reasoned about in the code and the integration tests genuinely need them.

### Follow-ups with numbers attached

- `recommendedTypeChecked` was measured, not guessed: about 30 real findings,
  and **none** of the `no-unsafe-*` flood Plotly's untyped surface suggested,
  because the casts at that boundary are explicit `as unknown as`. What is left
  is 22 redundant `!`, 3 template expressions and 2 needless `async`. Its one
  big number — 170 `no-floating-promises` — is entirely `describe`/`it` in
  node:test files and needs that rule off for `src/test/**`. Enabling it also
  needs `parserOptions.project` listing all three tsconfigs, because the
  project service alone does not find the test files.
- Enabling `noUncheckedIndexedAccess` (done) cost exactly one fix and makes the
  `!` assertions the codebase already uses everywhere compiler-enforced.


## Feedback V4 — addressed

- [x] Three commands, as asked: **Open Workspace…** (a quick pick whose first
      entry is a new empty workspace, folding in the old New Viewer Tab),
      **Save Workspace…**, **Discard Workspace…**. `Add Sample…` and
      `Discard Remembered Samples` are gone.
- [x] Right-click gives **Open in FCS Viewer** (always a new workspace) and,
      only when one is open, **Add to FCS Viewer Workspace** — gated on a new
      `fcsViewer.workspaceOpen` context key that `PanelManager` maintains.
- [x] Double-click already behaved as asked; it now has a test.
- [x] **Show Log**: it revealed the `FCS Viewer` output channel (parse timings,
      keyword warnings, webview errors). Worth having, but the Output panel's
      own dropdown already reaches that channel, so the command was redundant.
      Removed.
- [x] **The 8-most-recent limit never applied to saved workspaces.** Two things
      shared the word: saved workspaces (`fcsViewer.namedWorkspaces`, explicit,
      never pruned) and the automatic per-tab memory (`fcsViewer.sessions`,
      pruned to 8 so that restoring tabs after a reload does not grow forever;
      VS Code gives no reliable signal that a tab was closed rather than the
      window shut). Both live in `context.workspaceState` — keyed to the folder
      you opened, but stored in VS Code's own SQLite file, **not** in the
      project, so they cannot be committed or shared. Documented in the README;
      you chose to leave them there.
- [x] The workspace name is in the header, above the file name, reading
      "Unsaved workspace" until it is saved.
- [x] **UMAP instead of t-SNE**, as a plot type in the Plots tab.

### Why not t-SNE

Every maintained pure-JS t-SNE is exact O(N²) in time *and* memory — no npm
package ships Barnes-Hut except an unmaintained v0.1.0 WASM binding. At 5,000
events the probability matrix alone is ~200 MB before a single iteration, and a
run takes minutes. `tsne-js`, the package the feedback linked, is worse: last
touched in 2016, and it builds its kernels through `cwise`, which calls
`new Function` at import time — our CSP has no `'unsafe-eval'`, so it would not
even load.

`umap-js` is MIT, ~120k downloads/week, one pure-JS dependency, no `eval`, and
its optimizer is not O(n²). It is also the de-facto standard in modern
cytometry, so this is not a scientific downgrade. Cost: **+116 KB** minified.

### Why the fit/transform split was dropped

The original shape — fit on 1,000 cells, then `transform()` the whole 5,000 —
was measured before building on it:

| | |
|---|---|
| `transform(5000)` | **~1,050 ms, fully synchronous** |
| of which kNN setup | ~500 ms, cannot be yielded |
| chunking it | changes coordinates by 16.5 against a span of 27 — batches are not independent, so it is not a valid optimisation |
| `transformQueueSize` | no time saved, and drifts further than the span |

Fitting only, and plotting exactly the cells that were fitted, removes all of
that. At the 1,000 default the **only** blocking work is `initializeFit` at
~176 ms; all 500 epochs are steppable at 1.3 ms each.

| cells | blocks for | steppable |
|---|---|---|
| 500 | 120 ms | 330 ms |
| **1,000** (default) | **176 ms** | 670 ms |
| 2,000 | 357 ms | 1.4 s |
| 5,000 | 1,022 ms | 2.8 s |

`fitAsync` was not used in the end: it runs one epoch per `setTimeout`, which
spends more time in the scheduler than in UMAP at 1.3 ms an epoch, and it hides
`initializeFit` inside the same call so there is no chance to paint a
"preparing" state before the one part that does block. `initializeFit` plus a
time-sliced `step()` loop — reusing the draw queue's after-paint helper — gives
progress, cancellation and a plot that animates as it converges.

### Other UMAP notes

- **Parameters** are `Neighbours` (15) and `Min distance` (0.1). UMAP has no
  perplexity; `nNeighbors` is its locality parameter, and relabelling it
  "perplexity" would mislead anyone comparing against a t-SNE figure.
- **Preprocessing** reuses the existing pipeline: compensated values, the same
  per-channel transform the axes use, then standardised to unit variance.
  That last step is not cosmetic — without it the embedding is mostly a picture
  of whichever channel has the widest numeric range.
- **Colour** is applied on the transformed scale too. On raw intensities a
  marker positive in 3% of cells leaves everything else in the bottom colour.
- **Missing channels** are reported the way a scatter card's missing axis is;
  the mapping report now collects a UMAP card's whole channel list, which is
  the same defect as H4 last round in a new shape.
- Embeddings are cached in memory by a signature that excludes colour,
  colormap and point size, so switching samples and back is free — but nothing
  is persisted.

## Feedback V5 — addressed

Five things noticed while using the UMAP card.

1. **`Cells` looked like a second, independent subsample.** It never was —
   `data.rows(n)` clamps to the global subsample, so the events were always a
   prefix of the shared ones. The defect was in how it was presented: the
   dropdown offered 5,000 when the global subsample was 1,000. Renamed to
   **Max cells**, options are now clamped to the global subsample with an
   `All N` entry at the top, and the hint says it is a ceiling.
2. **Projection channels were not stable across samples.** The list was built
   from the active sample alone, so a channel the card was configured with
   simply vanished when it was not in that sample — leaving the card refusing
   to compute with no checkbox to untick. `projectionRows` now lists the
   card's own channels first (struck through and flagged *not here* when the
   sample lacks them), then the sample's remaining channels. Unit-tested in
   `channelResolver.test.ts`, since it is the kind of thing that is only wrong
   with two panels in play.
3. **Long labels.** The explanatory paragraphs under the UMAP controls
   (`Neighbours is UMAP's locality parameter…`, the cells note, the recolour
   note) are `title` tooltips on the controls they describe instead of taking
   up panel height. The channel rows are one clipped line each with the full
   `label — $PnN` in a tooltip too.
4. **No wheel zoom.** The card passed `scrollZoom: false`, copied from the
   contour card where each wheel tick rebuilds thousands of SVG paths. A UMAP
   is a few thousand markers, which is fine, so zoom is on below 4,000 points
   (and always with WebGL). Double-click and the mode-bar `autoScale2d` button
   — previously removed — now both mean *fit the points*, which is the only
   sensible home range for coordinates with no units.
5. **Header still said "Unsaved workspace" after saving.** `snapshot()` set the
   name and retitled the tab but never re-posted `fcs/samples`, the only
   message that carries the name. It now does. The panel records the name it
   last posted so the host test can see the difference; without the fix the
   new test in `namedWorkspace.test.ts` fails.

### Follow-ups from the same round

- **Colour by had the projection list's bug**, in the form that matters more:
  the select was keyed by channel *index*, so switching to a panel with a
  different marker at that index displayed the wrong marker and picking
  anything rewrote the card. `colorChoices` keys by `$PnN` and keeps the
  configured channel, flagged, when the sample lacks it; the card says it fell
  back to density rather than showing a plausible density plot in silence.
- **UMAP is capped at 5,000 cells** (`UMAP_MAX_CELLS`), independently of the
  global subsample: 10,000 is already a noticeable wait for structure that is
  legible at a fraction of it. The clamp is in the card, not just the
  dropdown, so an older saved config cannot exceed it.
- **The cap counts the rows being drawn, not the slice.** The first attempt
  used `data.sampledCount`, which is the size of the slice the host sent --
  and lowering the global subsample does not shrink it, so at a global 1,000
  the dropdown still offered 2,000 and 5,000 and the card embedded cells no
  other card was showing. Both the card and the dropdown now work from
  `indices`, the exact rows every other card draws.
- **Dividers.** The projection list rules a line between the card's channels
  and the rest, and the colour-by select lists the current choice — density
  included, so the divider does not come and go with the selection — then an
  `<hr>`, then density plus the sample's channels. Chromium renders a
  separator for an `<hr>` inside a `<select>`; anywhere it does not, it is
  ignored.
- **Compensation is a global setting again.** It used to be forced off when a
  sample had no spillover matrix, and stayed off after switching back — raw
  plots with no indication that anything had changed. The setting now survives
  the switch: `SampleData.column` already falls through to raw values, the
  header checkbox stays usable but is struck through, and the status bar says
  *Not compensated* naming the file and the keywords it looked for. The
  "compensated" wording in the table toolbar and the Overview note follows the
  effective value, not the setting. Regression test in `appReducer.test.ts`.

## Code review, round two — addressed

Twelve findings (N1-N12). Ten fixed, one deferred by choice, one disputed with
evidence.

**N1 — `disposeAll()` no longer closed the tabs.** Correct, and exactly the
refactor regression described: the call site used to say `panel.dispose()` and
became `dispose()` when the lifetime moved to `PanelManager`. There is now a
`close()` that disposes the `WebviewPanel`, `dispose()` guards re-entry because
`onDidDispose` calls it back, and `restore.test.ts` asserts the tab really goes
away — it needed an `until()`, because VS Code updates `tabGroups` a tick after
the panel is disposed. Reverting `close()` to `dispose()` fails that test.

**N2 — disputed.** The traced leak requires a newer activation to run between
this one's post-load supersession check and `registry.pin(id)`. There is no
await between those two statements, so nothing can interleave there: an
activation superseded before the check returns without ever pinning, and one
superseded after it has already set `activeId` to itself, so the newer
activation's unpin targets exactly this sample. A test that drives that precise
interleaving — pin taken, then superseded inside `buildPayload`, using the pin
itself as the signal for when to fire the second selection — passes against the
unmodified code. The self-releasing unpin was added anyway (it costs nothing and
makes the invariant local), and the test is kept for the invariant, but it is
not a regression test and is labelled as such. `debugSnapshot` now reports
`pinned` separately from `resident`, since residency was never a proxy for it.

**N3 — `PERSISTED_VERSION` bumped to 4**, with the reasoning in the constant's
comment: the range check exists so an older reader can decline, and a
shape-widening change that leaves the stamp alone disables it.

**N4 — cards are validated, not just the envelope.** `isCard` per kind, and
unreadable cards are dropped rather than thrown on: losing a tile beats blanking
the panel, which is what happened, because the webview's own `setState` restore
is not inside a try/catch. This forced a split — `persistedState.ts` holds the
version, migration and validation, `persistence.ts` keeps the read and write —
because the old module called `acquireVsCodeApi()` at import time and could not
be unit-tested at all. Nine cases in `persistedState.test.ts`.

**N5 — UMAP now transforms with `state.defaults.cofactor`**, the same number the
inspector edits, instead of deriving its own from `$CYT`. And the cofactor is
part of `embeddingSignature`, without which changing it would have served the
cached embedding of a different space — the reviewer's catch, and the more
important half of the finding.

**N6 — partly.** `license: MIT` and a LICENSE file are in; `publisher` is still
open by your choice, so C5 stays open. `.vscodeignore` uses `REVIEW*.md`, which
is what let REVIEW2.md into the packed set. CI runs `vsce package` as soon as a
publisher exists and prints a `::warning::` naming C5 until then, rather than
`vsce ls` passing silently right up to the first release attempt.

**N7** — `ResolverIndex.signature` and `panelSignature` deleted; `manualMapping`
is keyed by channel name, so they were not wired to the feature they were kept
for. **N8** — `pointDensity` derives its own extent when no domain is passed, so
the UMAP cap is no longer load-bearing for correctness. **N9, N10** — stale
comment and orphaned JSDoc fixed. **N11** — `colorBy` dropped from the mapping
report: it does not grey out a UMAP card, so raising the "cards using them are
greyed out" chip for it was the contradiction.

**N12** — noted, unchanged, same trade-off as round one.

### Still open

- ~~**C5: `publisher`.**~~ Closed: the manifest now carries `publisher`,
  `license` and `repository`, so CI's packaging step stops warning and starts
  gating. The two suites that hardcoded `undefined_publisher.vscode-fcs-viewer`
  now find the extension by the name half of its id (`thisExtension()` in
  `helpers.ts`) — the publisher is a deployment decision, not part of the
  identity under test.

  Worth recording, because it cost an afternoon of confusion: the manifest
  briefly carried `"version": "0.1"`, and VS Code discards an extension whose
  version is not `major.minor.patch` at scan time. The symptom is not an error
  anywhere — the extension is simply absent, so `.fcs` files open as text and
  no command exists. `vsce ls` reports it (`Invalid extension version`) and is
  the fastest way to tell "manifest rejected" from "activation threw".
- ~~**`icon`.**~~ Closed: `logo.png`, a 128×128 RGBA PNG at the repo root.
  VS Code takes PNG only — not `.ico`, not SVG — at 128×128.
- `vsc-extension-quickstart.md` is still in the tree (it is excluded from the
  package).

## Resizable sidebars

Both sidebars were already `flex: 0 0 <px>` on a flex row, so the layout part
was small: the width moves to a CSS variable on the container
(`--samples-w` on `.app-body`, `--inspector-w` on `.plots-view`), a shared
`Resizer` sits between the panel and the content, and the width lives in the
reducer as `layout` and rides the existing persisted blob (`PERSISTED_VERSION`
bumped to 5, widths clamped in `coerce` so a width from a wide monitor cannot
come back and swallow a narrow window).

Three things that were not obvious:

- **A dispatch per pointermove is too expensive**, and not because of React:
  it makes every visible Plotly card resize inside the same task. The drag
  writes the CSS variable straight onto the container and commits to the
  reducer once, on pointerup.
- **Even so, a live drag was laggy on a full grid** — the browser re-lays out
  every plot's DOM as the grid reflows: ~125 ms a frame with six cards, all of
  it browser layout rather than our JS. Skipping the card bodies with
  `content-visibility: hidden` for the length of the gesture takes the drag to
  0 ms of long tasks; the plots catch up afterwards, one per frame.
- **A skipped subtree delivers no resize observations, and Chromium does not
  deliver the ones it missed when the subtree returns.** Leaving the catch-up
  to each chart's ResizeObserver left every plot rendered at its pre-drag
  width until something else happened to resize it. `layoutDrag.ts` makes the
  flush explicit instead. Measured with `scripts/preview.mjs --resize-probe`,
  which drives real pointer events and reports whether any plot's internal
  width still disagrees with its container.

`PlotlyChart`'s resize also now goes through the draw queue, keyed on a token
of its own rather than on the element — keying it on the element would let a
queued resize replace a queued `Plotly.react` and swallow new data.

## Next

- t-SNE, if anyone wants it alongside UMAP. It needs either a point cap around
  2,000 (exact JS implementations are O(N²) in memory as well as time) or a
  Barnes-Hut implementation, which does not exist on npm in maintained form.
  `@keckelt/tsne` is the one worth using if so: MIT, zero dependencies, 17 KB,
  and it exposes `step()`, so it would slot into the same time-sliced loop UMAP
  uses.
- A Web Worker, if anything heavier than UMAP is ever added. Investigated and
  found unnecessary, but two findings are worth keeping: `new Worker` on a
  webview resource URI cannot work (the document and the resources are on
  different origins), so it must be a `blob:` worker with `worker-src blob:`
  added to the CSP; and nothing `SampleData` owns is transferable, because its
  arrays are views into a shared buffer.
- Gating. The overlay layer and the shared subsample permutation were built
  with this in mind: every card draws the same cells, so a gate defined on one
  card can highlight on another.
- Copy a plot to the clipboard. PNG export works through Plotly's camera
  button; clipboard needs `toImage` plus a host round-trip, since
  `navigator.clipboard` is unreliable in webviews.
- Manual channel remapping UI. The resolver and its persistence keyed by panel
  signature already exist; only the picker for unresolved channels is missing,
  so today you re-pick the channel on the card.
- Overlay several samples on one histogram, which is the natural payoff of
  keeping cards alive across sample switches.

## Links

- https://code.visualstudio.com/api/get-started/your-first-extension
- https://ym3141.github.io/EasyFlowQ/
