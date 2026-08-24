# FCS Viewer

Inspect flow and mass cytometry data directly in VS Code. Open an FCS file,
read its metadata and statistics, browse events in a table, and build a grid of
plots — then flip between samples and watch every plot redraw for the new file.

## Features

**Samples sidebar.** Load several FCS files into one viewer workspace. Exactly
one is active at a time; selecting another redraws your existing plot cards
against it, so you configure a panel of plots once and reuse it across a run.

**Plot cards.** A reflowing tile grid of scatter plots (with density
colouring), density contour plots, single-channel histograms, and UMAP
projections. Cards can be reordered, resized, enlarged, and edited in a
right-hand inspector. Zoom, pan, hover readouts and PNG export are built in.

**UMAP.** Project any set of channels onto two dimensions, coloured by density
or by a channel's expression. It runs incrementally, a few epochs per frame, so
the window stays usable and the embedding animates as it converges — and
recolouring reuses the embedding rather than recomputing it.

Two things worth knowing. UMAP plots the cells it embedded, not the whole
subsample: `Max cells` is a ceiling on top of the global subsample, 1,000 by
default, capped at 5,000 whatever the global subsample is — beyond that the
neighbour graph costs more than the extra cells are worth. The embedded cells
are always a prefix of the shared subsample, so they are the same cells the
other cards draw first. Both the projection channels and the colour channel
survive a switch to a sample that does not have them: they stay on the list,
flagged, so the card stays comparable across samples and an unavailable channel
can still be removed.
Channels are compensated, transformed the way the axes are (arsinh for markers,
linear for scatter and time) and then standardised to unit variance — without
that last step the embedding is mostly a picture of whichever channel has the
widest numeric range.

`Neighbours` is UMAP's locality parameter, the closest thing it has to t-SNE's
perplexity. It is not t-SNE: cluster shapes and the distances between clusters
are not comparable with a t-SNE figure from another tool.

**Compensation** applies `$SPILLOVER`, `$SPILL` or a bare `SPILL` matrix, and is
a global setting rather than a per-sample one. Switching to a sample with no
matrix leaves it on — that sample's values are shown raw, the status bar says
so, and the samples that do have a matrix stay compensated.

**Resizable panels.** The samples sidebar and the plot inspector both resize by
dragging their border — double-click to reset, or focus the border and use the
arrow keys (`Shift` for larger steps). Widths are remembered per viewer tab and
saved with a workspace.

**Transforms.** Linear, arsinh with an editable cofactor, or the GatingML 2.0
log, set per axis. The default arsinh cofactor is chosen from `$CYT` — 5 for
mass cytometry, 150 for fluorescence.

The log transform is `flog(x, M, T) = (1/M)·log₁₀(x/T) + 1`, which maps
`[T·10⁻ᴹ, T]` onto `[0, 1]` — so M is the number of decades shown and T the top
of the scale, and both directly set the visible range. They are derived from
the channel until you set them; **Auto** puts them back.

**Compensation.** If the file carries a spillover matrix, a single toggle
applies it across plots, the table and the statistics.

**Overview and table.** All metadata, per-channel statistics, the spillover
matrix, and a virtualised, sortable event table.

**Saved workspaces.** A viewer tab — its samples and its plot cards — can be
saved under a name and reopened later. See below.

## Getting started

**Double-click a `.fcs` file** in the Explorer. It opens in the viewer rather
than as text, and no leftover editor tab is left behind.

Double-clicking starts a workspace if none is open, and adds the file to the
one you have otherwise. Right-clicking a `.fcs` file offers **Open in FCS
Viewer** (always a new workspace) and, when one is open, **Add to FCS Viewer
Workspace**; both work on a multi-selection. The **+** in the samples sidebar
opens a file picker.

To read the raw bytes instead, use **Open With → Text Editor** (or the Hex
Editor). That bypasses the viewer entirely and the tab is left alone.

### Viewer tabs

You can keep several workspaces open, each with its own samples, active sample
and plot cards — useful for keeping separate experiments apart. **FCS Viewer:
Open Workspace…** offers a new empty one as its first entry. Each workspace
remembers its sample list and restores it when the window reloads.

### Saved workspaces

That automatic memory is unnamed and pruned to the eight most recent, so that
reopening VS Code puts your tabs back without growing forever. For anything you
want to come back to, save it explicitly with **Save Workspace…**; saved
workspaces are **never** pruned.

Saving under an existing name replaces it. **Open Workspace…** reopens one in a
tab of its own, so it never disturbs a workspace you are working in.

Where they live: VS Code's workspace state for the folder you opened — keyed
per folder, because the samples are file paths that only mean something there.
Physically that is a SQLite file inside VS Code's own storage
(`.../User/workspaceStorage/<hash>/state.vscdb`), **not** a file in your
project, so saved workspaces cannot be committed or shared with a collaborator.
They are an FCS Viewer concept, unrelated to VS Code workspaces
(`.code-workspace`).

## Commands

Three, all under the **FCS Viewer** category:

| Command | Does |
| --- | --- |
| `Open Workspace…` | Pick a saved workspace, or start a new empty one |
| `Save Workspace…` | Name the current workspace's samples and plot cards |
| `Discard Workspace…` | Delete a saved workspace; the FCS files are untouched |

Right-clicking a `.fcs` file adds **Open in FCS Viewer** (always a new
workspace) and, when one is already open, **Add to FCS Viewer Workspace**.

There is no command for the log. The extension writes parse timings, keyword
warnings and webview errors to an `FCS Viewer` channel in the **Output** panel,
which VS Code's own dropdown already reaches.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `fcsViewer.defaultSampleSize` | `5000` | Events plot cards render by default |
| `fcsViewer.defaultCofactor` | `0` | Arsinh cofactor; `0` picks from `$CYT` |
| `fcsViewer.maxFileSizeMB` | `1024` | Prompt before opening larger files |
| `fcsViewer.maxSliceMB` | `16` | Confirm before transferring more than this |

## Supported files

FCS 2.0 through 3.2, list mode (`$MODE L`), with `$DATATYPE` F, D or I —
including packed non-byte bit widths, `$PnR` masking, `$PnE` log decoding and
`$PnG` gain. Little-, big- and mixed-endian `$BYTEORD` are all handled, as are
files that delegate their data offsets to `$BEGINDATA`/`$ENDDATA`.

Some writers declare the DATA segment's last byte exclusively rather than
inclusively, and some are off by a byte in the other direction. Both are
repaired: `$TOT` and the channel widths say exactly where the data ends, so an
end offset that disagrees by less than one event is corrected and reported.
There is no flag to set — the repair is bounded by the declared event count and
the file length, so it cannot invent events or read past the end.

Not supported: ASCII-encoded data (`$DATATYPE A`) and the correlated and
uncorrelated histogram modes removed in FCS 3.1. Files with several datasets
show the first one.

Read-only throughout. The extension never writes to your FCS files.

## Development

```sh
npm install
npm run watch        # esbuild + tsc in watch mode
```

Press <kbd>F5</kbd> to launch an Extension Development Host.

```sh
npm run check-types  # type-check the host and webview separately
npm run lint
npm run test:unit    # parser and state tests under node:test, no VS Code needed
npm test             # integration tests in a real VS Code host
```

Unit tests build their own FCS fixtures in memory. To additionally run the
tests that assert against real files:

```sh
FCS_TEST_FILE=data/export_P01_US.863433.fcs \
FCS_TEST_FILE_2=data/001.fcs npm run test:unit
```

### Releasing

Bump `version` in `package.json` (it must be `major.minor.patch` — VS Code
silently discards an extension whose version is not valid semver, so it never
loads and there is no error to read), update `CHANGELOG.md`, then:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

`.github/workflows/release.yml` packages one `.vsix` and publishes it to both
the VS Code Marketplace and Open VSX. It needs two repository secrets —
`VSCE_PAT` (Azure DevOps, scoped to Marketplace › Manage) and `OVSX_PAT`
(open-vsx.org access token) — and the Open VSX namespace has to be created once
by hand:

```sh
npx ovsx create-namespace chillerb -p <OVSX_PAT>
```

To try a build without publishing: `npx @vscode/vsce package`, then install the
`.vsix` from the Extensions view (**…** › *Install from VSIX*).

### Previewing the webview

A webview cannot be inspected from the extension test host, so
`scripts/preview.mjs` renders the built bundle in a real browser against a real
file and saves a screenshot. Puppeteer is deliberately not a project
dependency; install it when you need it.

```sh
npm i -D puppeteer
npm run compile-tests && npm run compile
node scripts/preview.mjs data/001.fcs --tab plots --cards 3 --theme dark
```

On a machine with no display, prefix with `xvfb-run -a`. Useful flags:
`--kind contour`, `--transform log`, `--set "M (decades)=2"`, `--no-webgl null`,
and `--reload`, which re-delivers the sample once the cards exist and reports
long tasks — the honest measure of a frozen window.

Note that the webview is built with React's **production** runtime even for
debug builds. React 19's development runtime serialises component props for its
Performance track, and the props here include the typed arrays handed to
Plotly; that alone blocked the main thread for about two seconds on every
sample switch. Pass `--react-dev` to `esbuild.mjs` when you need React's
development warnings.

### Layout

```
src/common/     parser, statistics, transforms, message protocol (no vscode, no DOM)
src/extension/  panel manager, viewer panel, message router, sample registry,
                matrix cache, slice budget, open queue, webview HTML
src/webview/    React UI: state, views, Plotly rendering, theming, UMAP
src/test/       unit tests (node:test) and integration tests (VS Code host)
```

`PanelManager` owns the open viewer tabs and the `MatrixCache` they share, and
is created once by `activate()`. Nothing in `src/extension/` holds mutable
module-level state.

`src/common` is compiled by both the host and webview configs, so it may use
neither node built-ins nor DOM globals.
