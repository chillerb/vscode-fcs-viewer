# Change Log

All notable changes to the FCS Viewer extension are documented here.

## [0.1.0] - 2026-08-24

First working version: open FCS files in a viewer workspace, inspect their
metadata and statistics, browse events in a table, and build a grid of plot
cards that redraw when you switch samples.

### Added

- **FCS parser** covering FCS2.0 through FCS3.2, `$MODE L`, `$DATATYPE` F/D/I
  (including packed non-byte bit widths and `$PnR` masking), little-, big- and
  mixed-endian `$BYTEORD`, delegated `$BEGINDATA`/`$ENDDATA` offsets, `$PnE`
  log decoding, and `$PnG` gain. Unsupported files fail with a specific reason
  rather than a stack trace.
- **FCS Viewer workspace**: one panel holding several samples with one active.
  Selecting another sample in the left sidebar redraws every existing plot card
  against the new file instead of making you rebuild them.
- **Overview tab** with file metadata, per-channel statistics
  (min/max/mean/SD/percentiles, zero and negative counts), the spillover matrix
  and the raw keyword dump.
- **Table tab**: virtualised event table, sortable by any column, with column
  selection and copy-as-TSV.
- **Plot cards**: scatter plots with density colouring, density contour plots,
  single-channel histograms and UMAP projections, in a reflowing tile grid with
  drag-to-reorder, resizable spans, an enlarge overlay, and a right-hand
  inspector. Zoom, pan, hover and PNG export come from Plotly.
- **UMAP** as a plot type. Any set of channels projected to two dimensions,
  coloured by density or by a channel. Computed incrementally at a few epochs
  per frame so the window stays usable and the layout animates as it settles;
  seeded, so the same card gives the same layout twice. Recolouring reuses the
  embedding — the cache key deliberately excludes anything that only affects
  appearance. `Max cells` is a ceiling on the global subsample rather than a
  second sample of its own, itself capped at 5,000; the projection list and the
  colour channel both keep channels the active sample lacks, so the card stays
  consistent when you switch samples.
- **Transforms** per axis: linear, GatingML 2.0 flog and arsinh with an editable cofactor,
  defaulting to 5 for mass cytometry and 150 for fluorescence based on `$CYT`.
- **Resizable sidebars.** Drag the border of the samples list or the plot
  inspector; double-click it to reset, or focus it and use the arrow keys. The
  widths persist and travel inside a saved workspace. Plot contents are skipped
  for the length of the drag and catch up when it ends, which is what keeps a
  full grid of cards from making the drag stutter.
- **MIT licence**, and the package now carries `license` in its manifest.
- **Compensation** from `$SPILLOVER`, `$SPILL` or a bare `SPILL` keyword,
  applied as a global toggle across plots, table and statistics. A sample
  without a matrix is shown raw and says so in the status bar; it does not
  silently switch the setting off for the samples that have one.
- **Subsampling** as a global setting, 5,000 events by default. Only the
  subsampled events are transferred to the viewer.
- **Double-click to open.** A `.fcs` file opens in the viewer instead of being
  decoded into a text buffer. `Open With → Text Editor` remains as the escape
  hatch for reading the raw bytes.
- **Several viewer tabs**, each with its own samples, active sample and cards,
  so different experiments stay apart. Parsed matrices are shared between tabs,
  so two tabs showing the same file only parse it once.
- **Sample lists are remembered per tab and per workspace**, and restored when
  the window reloads. Only the active sample is re-parsed; the rest populate the
  sidebar from cached counts. A file that has moved comes back flagged rather
  than silently disappearing.
- **Named viewer workspaces.** Save a tab's samples and plot cards under a name
  and reopen them later, into a tab of their own. Separate from the automatic
  per-tab memory above, which is unnamed and pruned; deleting a saved workspace
  is a deliberate act, and "Discard Remembered Samples" leaves them alone.
- **Status bar** along the bottom of the viewer, carrying load progress and any
  messages — missing channels, approximate matches, parse issues — with details
  in a drawer.

### Notes on behaviour worth knowing

- The log transform's M and T set the visible range, following GatingML: flog
  maps `[T*10^-M, T]` onto `[0, 1]`. They are derived from the channel unless
  set, because the spec's own defaults of M = T = 1 frame every axis on 0.1 to
  1. Under an explicit min and max they only rescale the axis, which is
  inherent: flog is affine in log10.

- A doubled TEXT delimiter is read as an empty value when it follows a keyword,
  and as an escaped delimiter otherwise. Real files contain both, and getting
  this wrong silently misaligns every subsequent keyword.
- Compensation applies only to the channels the spillover matrix actually
  lists; everything else, including FSC, SSC and Time, passes through
  untouched. It always runs on raw values before any axis transform.
- Values a log axis cannot represent are excluded and counted, never clamped
  onto the axis edge, because clamping fabricates a dense edge that reads as a
  real population.
- Plot cards reference channels by name. Switching to a sample where a channel
  cannot be resolved greys the card out and says which channel is missing,
  rather than falling back to the column index and plotting the wrong marker.
- Closing a viewer tab does not discard its remembered samples. VS Code fires
  the same disposal event when a user closes a tab and when it tears the window
  down, so clearing on close would wipe state exactly when it should be kept.
  Old lists are pruned to the eight most recent instead.

### Changed

- **The command surface is three verbs**: `Open Workspace…` (which offers a new
  empty workspace as its first entry), `Save Workspace…` and
  `Discard Workspace…`. `New Viewer Tab` folded into the first;
  `Add Sample…`, `Discard Remembered Samples` and `Show Log` are gone. The log
  is still written to the `FCS Viewer` output channel, which the Output panel
  reaches without a command.
- The explorer menu is now **Open in FCS Viewer** (always a new workspace) and
  **Add to FCS Viewer Workspace**, the second gated on a workspace actually
  being open via a new `fcsViewer.workspaceOpen` context key.
- The header shows the workspace name, or "Unsaved workspace".

- The webview's message router, the open-file queue, the slice budget, the
  panel registry and the matrix cache are separate modules. The cache and the
  registry of open tabs are now a `PanelManager` instance owned by `activate()`
  rather than module-level statics: sharing parsed matrices between tabs is a
  real requirement, but nothing about it needs the state to be globally
  reachable, and that is why a pin leak was easy to introduce and hard to see.
  `SampleRegistry` takes its cache as a constructor argument, which is what
  makes it testable.
- `Copy to clipboard` copies the whole subsample rather than the rows that
  happened to be on screen, and the button says how many rows that is.
- Log axis labels use SI prefixes throughout. Above 1e6 they fell through to
  plain formatting, so one axis read `100k` and the next `1,000,000`.
- ESLint runs typescript-eslint's `recommended` set,
  `eslint-plugin-react-hooks` and `no-unused-vars`;
  `noUncheckedIndexedAccess` is on, which makes the `!` assertions the code
  already used everywhere actually mean something.
- CI runs type-checking, linting, unit tests and the VS Code integration suite.

- Commands moved from the "FCS" category to "FCS Viewer", and lost the
  redundant "FCS Viewer" in their titles: `FCS: Open in Current FCS Viewer Tab`
  is now `FCS Viewer: Open in Current Viewer Tab`. `Clear Workspace` became
  `Discard Remembered Samples`, to keep it apart from named workspaces.
- "Dot plot" is called "Scatter", and plot type is a dropdown rather than a
  pair of buttons.
- The header's "+ Plot" button is gone. It applied to the Plots tab from a
  global toolbar; adding a card is the "+ Add plot" tile at the end of the grid.
- The webview is built from a custom Plotly bundle (core plus `scattergl` and
  `histogram2dcontour`) rather than the prebuilt `plotly-gl2d` file, which has
  no contour trace. It is slightly smaller than the bundle it replaces.
- The last three d3 packages, `d3-array`, `d3-format` and `d3-scale-chromatic`,
  are gone. Tick generation and the number formats are about 120 lines in
  `src/common`, and Plotly only ever received twelve colour stops per colormap,
  which are baked in.
- `node_modules` is excluded from the package. Nothing there ships — everything
  is bundled — and anything installed outside `package.json`, such as puppeteer
  for the preview script, was otherwise read as a production dependency and
  packed into the vsix.

### Fixed

- **Saving a viewer workspace silently discarded the plot cards.** The sample
  list came back; the layout the user actually built did not. Neither half of
  the round-trip was connected -- the host never kept the webview's UI blob,
  and never sent it back on restore -- and the test that would have caught it
  declared the field it needed and never asserted on it.
- Parsed matrices were pinned in the cache on every activation and released
  only when the tab closed, so the documented three-matrix limit stopped
  applying after the third sample. Clicking through ten CyTOF files held about
  310 MB that nothing would reclaim.
- Two quick sample switches could leave the viewer showing one sample while the
  host, the tab title and the sidebar all believed another was active: the
  activation payload had no way to be recognised as superseded, unlike the
  slice path. Activations are numbered now.
- Warnings from a singular spillover matrix were appended to metadata owned by
  the cache and shared between tabs, so they accumulated a fresh copy on every
  re-activation.
- Cancelling a large file did nothing. The cancellation token was only checked
  on the slow parsing path, and the 31 MB mass-cytometry case takes the fast
  one. Re-slices are cancellable too, and a newer subsample request cancels the
  one in flight.
- A contour card whose Y channel is missing from the current sample greyed out
  while the status bar reported no problem.
- The loading indicator never appeared. The message that sets it was fully
  handled in the webview and never sent by the host.
- A late subsample request for a sample that was no longer active still set the
  size used for the next sample's first slice.
- The "file too large" error told the user to raise a setting that does not
  control the limit it hit.
- The CSP nonce came from `Math.random()`.
- Two collections grew for the life of the session: one entry per file opened
  on the extension's disposal list, and one record per delivered slice in a
  log kept only for tests.
- Closing the viewer tabs from the test hooks tore down their listeners but
  left the webviews on screen -- tabs that looked like viewers and answered
  nothing.
- A persisted workspace was validated at the envelope but not the cards, so one
  malformed card blanked the panel with nothing said. Unreadable cards are
  dropped now, and the persisted version was bumped so an older build declines
  a workspace containing a card kind it has never heard of.
- UMAP transformed with an arsinh cofactor derived from the file rather than
  the one the inspector edits, so tuning the cofactor left the projection in a
  different space from every other card. The cofactor is part of the embedding
  identity now, or the cached projection would have survived the change.

#### FCS files with wrong DATA offsets

- Files that declare the DATA segment's last byte *exclusively* rather than
  inclusively -- the case Python's flowkit gates behind `ignore_offset_error`
  -- were already read correctly, but reported a warning claiming the file was
  truncated, which made a perfectly good file look corrupt.
- The mirror-image bug was worse and silent: an end offset one byte short
  dropped the final event. `$TOT` and the channel widths say exactly where the
  data ends, so an end that disagrees by less than one whole event is now
  repaired in either direction, bounded by both the declared event count and
  the physical file length.
- A DATA segment that is not a whole number of events is reported instead of
  being rounded away silently.
- `$ENDDATA` is compared against the HEADER's end offset. Only the *begin*
  offsets were ever compared, so a file with a correct begin and a bogus end
  went through without a word.

- The UI still froze for about a second on every sample switch, and it was
  React's **development** runtime rather than anything in this extension. React
  19 serialises component props for its Performance track, and those props
  include the typed arrays handed to Plotly. On a 146,215 x 56 file with six
  cards that cost 2,054 ms of blocked main thread; with the production runtime
  it is 0 ms, with no task over 50 ms. The webview now builds against
  production React even for debug builds, so pressing F5 gets the same
  behaviour as the packaged extension; `--react-dev` opts back in.
- Plot draws are queued one per frame instead of all running in the effect pass
  of a single commit, so a grid paints progressively and the window stays
  responsive. Most visible where WebGL is unavailable and scatter falls back to
  SVG: eight cards went from one 398 ms task to seven of at most 64 ms.
- The log transform's M and T had no effect on the plot. They could not: flog
  is affine in log10, so against a percentile-derived range they moved the
  values, the range and the tick positions by the same amount and the picture
  never changed. The range now comes from the parameters.
- Loading a sample froze the UI, worst for large files and worse again with
  another sample already open. The host was posting the entire event matrix --
  31 MB for a 146,215 x 56 file -- and on a remote or dev container setup the
  extension host and the webview renderer sit on opposite sides of a tunnel, so
  every byte crossed it. Only the subsample is transferred now: 1.09 MB at the
  5,000 default, and growing the subsample re-fetches while shrinking is served
  from what is already in memory. Nothing reads events outside the subsample,
  and compensation has no cross-event term, so the values are unchanged.
- The quantile pass blocked the extension host in one 267 ms burst, mostly
  allocating and copying a fresh filter buffer per channel. It now reuses one
  buffer and yields every few channels, so it cannot stall a subsample request.

- Dot plots showed only "WebGL is not supported by your browser" whenever the
  subsample was at or above 10,000, and adding a sample froze the UI for tens of
  seconds. One cause: above 6,000 points the plots used Plotly's WebGL trace,
  WebGL is unavailable in some VS Code windows (Electron blacklists the GPU on
  many Linux and remote setups), and each failed context attempt blocks the
  renderer on a synchronous GPU-channel call, compounding across cards. WebGL is
  now probed once — matching exactly what the plotting library requires, since a
  looser check reports success and still renders a white box — and without it
  plots fall back to SVG capped at 5,000 points, with a notice saying so.
- Every sample load rendered each card twice. The follow-up statistics message
  created a new data object, and reading a channel returned a fresh array view
  each time, so the render memos never saw an unchanged value. Channel views are
  now memoised, which halves the work of every sample switch regardless of WebGL.

- The extension declared no activation events, so after a window reload it never
  activated and a restored viewer panel stayed dead. Restoring also ignored the
  panel state entirely and rebuilt an empty sample registry.
- A sample that failed to parse left the panel showing "Loading…" indefinitely,
  because the empty state keyed off the sample count rather than whether any
  sample had actually loaded.
