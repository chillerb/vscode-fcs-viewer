# Code Review — FCS Viewer

Review of `vscode-fcs-viewer` at commit `237eca5` ("finish prototype"), version 0.0.1.
Scope: all of `src/` (~7,100 lines of source, ~1,400 lines of tests), the build pipeline,
TypeScript and ESLint configuration, and the extension manifest.

Each finding is tagged with a priority:

| Tag | Meaning |
| --- | --- |
| **Critical** | Broken behaviour, unbounded resource growth, or a release blocker. Fix before shipping. |
| **High** | A real defect, but with a narrower blast radius. Fix soon. |
| **Medium** | Maintainability, duplication, dead code. Fix when convenient. |
| **Low** | Preference and polish. Take it or leave it. |

---

## 1. Summary

| Dimension | Rating | Comment |
| --- | --- | --- |
| Architecture | **A−** | Host/webview split, the protocol boundary, and the subsample transfer model are all right. One class carries too much. |
| Implementation | **B+** | Careful numerics and rendering. A handful of genuine wiring and lifetime bugs. |
| Documentation | **A** | Comments explain *why*, including alternatives that were rejected and why. Rare and valuable. |
| Tests | **B−** | Good unit coverage of the parser; integration tests exist and are honest. The highest-value assertions are gated off, and the broken feature below is untested. |
| Production readiness | **C** | Manifest metadata missing, one feature half-wired, one memory-retention bug, no CI. |

This is a strong prototype. The design decisions that matter most for this problem domain —
keeping the parsed matrix on the extension host and sending only a subsample across the wire,
gathering that subsample in permutation order so a prefix is a valid smaller sample — are
correct and non-obvious, and the code explains why it made them. The gap between "prototype"
and "shippable" is a short list of specific defects, not a structural problem.

---

## 2. What the design gets right

Worth stating explicitly, because these are the parts a refactor should not disturb.

**The data-transfer model.** [protocol.ts:29-53](src/common/protocol.ts#L29-L53) establishes
that only the subsample crosses the boundary, never the full matrix. In a dev container or
remote session the extension host and the webview renderer sit on opposite sides of a tunnel,
and a 31 MB matrix takes seconds to move; at the 5,000-event default this is ~1 MB. Paired with
[`gatherSlice`](src/common/sampling.ts#L52), which returns rows in permutation order rather than
sorted, this makes shrinking the subsample a purely local operation with no round-trip
([useSliceRequests.ts:37](src/webview/state/useSliceRequests.ts#L37)). That invariant is stated
in three places and respected everywhere. It is the best idea in the codebase.

**A single, versioned protocol.** [protocol.ts](src/common/protocol.ts) is one discriminated
union per direction, with `PROTOCOL_VERSION` and an `assertNever` exhaustiveness guard on the
host's switch. Every message type is documented with the reason it exists.

**A dependency-free parser.** [src/common/fcs/](src/common/fcs/) handles FCS 2.0–3.2 with no
third-party code, and handles the hard parts: the doubled-delimiter ambiguity is resolved by
token parity with a worked example from a real CyTOF file
([text.ts:9-33](src/common/fcs/text.ts#L9-L33)); `$BEGINDATA`/`$ENDDATA` offset repair
([keywords.ts:155-174](src/common/fcs/keywords.ts#L155-L174)); non-byte-aligned integer channels;
`$BYTEORD` permutations. Malformed input degrades to a structured warning rather than an
unopenable file.

**Numerical care.** Welford for variance on wide dynamic ranges
([stats.ts:38](src/common/fcs/stats.ts#L38)); Floyd–Rivest quickselect for quantiles instead of a
full sort ([stats.ts:126](src/common/fcs/stats.ts#L126)); `Math.asinh` rather than the
`log(u + sqrt(u²+1))` identity, with the reason given
([transform.ts:73-76](src/common/fcs/transform.ts#L73-L76)); density normalised against a high
percentile of occupied cells rather than the maximum, because mass-cytometry data piles up at
exactly zero ([density.ts:77-89](src/webview/render/density.ts#L77-L89)); compensation applied
before any axis transform, with "arsinh-then-compensate is silent garbage" written down
([compensation.ts:69-78](src/common/fcs/compensation.ts#L69-L78)).

**Rendering pragmatism grounded in measurement.** The WebGL probe mirrors exactly what regl asks
for, releases its context, and can be downgraded at runtime when Plotly puts up its white box
anyway ([webgl.ts](src/webview/render/webgl.ts)). Draws are serialised one per frame so a card
grid paints progressively ([drawQueue.ts](src/webview/render/drawQueue.ts)). React's development
runtime is disabled even for debug builds, with the measurement that justifies it — 2,054 ms of
blocked main thread versus 0 ms ([esbuild.mjs:5-18](esbuild.mjs#L5-L18)).

**Build and type hygiene.** Three non-overlapping tsconfigs mean host code cannot reference
`window` and webview code cannot reach for `process`, enforced by `lib` and `types` rather than
by convention. The CSP is nonce-locked with a documented reason for each directive
([webviewHtml.ts:18-30](src/extension/webviewHtml.ts#L18-L30)). `.vscodeignore` explains why
`node_modules/**` is excluded and what happens without it.

**Exact-only channel matching.** [channelResolver.ts:40-49](src/webview/state/channelResolver.ts#L40-L49)
requires index, `$PnN` and `$PnS` all to agree, with no case folding or punctuation stripping,
on the grounds that a near-match is more likely a different marker and plotting the wrong marker
silently is the worst available outcome. That is the right call for a scientific tool.

---

## 3. Critical

### C1. Named-workspace UI state is wired at neither end

The "Save Viewer Workspace…" / "Open Viewer Workspace…" feature restores the sample list but
silently loses the card layout, table columns and subsample size — the part users actually built.
Both halves of the round-trip are missing:

- **Saving.** The `webview/persistState` handler writes the blob to a workspace-state key and
  never assigns `this.uiState` ([fcsViewerPanel.ts:600-602](src/extension/fcsViewerPanel.ts#L600-L602)).
  `snapshot()` reads `this.uiState` ([fcsViewerPanel.ts:297](src/extension/fcsViewerPanel.ts#L297)),
  so the saved workspace's `ui` field is *always* absent.
- **Restoring.** `pendingUiState` is assigned from the seed
  ([fcsViewerPanel.ts:230](src/extension/fcsViewerPanel.ts#L230)) and then never read. The
  `host/restoreState` message it would travel in has a complete, correct handler in the webview
  ([useHostMessages.ts:129-139](src/webview/state/useHostMessages.ts#L129-L139)) — including
  routing through the same `coerce()` migration as the webview's own blob — but **nothing in the
  codebase ever sends it**.

The field comments at [fcsViewerPanel.ts:60-66](src/extension/fcsViewerPanel.ts#L60-L66)
("The webview posts it whenever it changes", "Pushed to the webview on ready") describe intended
behaviour that the code does not have, which is how this stayed invisible.

Nothing caught it because `namedWorkspace.test.ts` declares `hasUi` in its `Listed` interface
([namedWorkspace.test.ts:21](src/test/integration/namedWorkspace.test.ts#L21)) — the
`debugWorkspace 'list'` command already reports it
([fcsViewerPanel.ts:195](src/extension/fcsViewerPanel.ts#L195)) — and never asserts on it.

**Fix.** Three small changes: assign `this.uiState = m.state` in the `webview/persistState`
handler; post `{ type: 'host/restoreState', state: this.pendingUiState }` from the
`webview/ready` branch when `pendingUiState !== undefined` (before `setActive`, so the restored
card layout is in place when the first slice lands); and assert `hasUi === true` in the
save-then-list test.

### C2. `UI_STATE_KEY` is one global key in a per-tab design

[workspaceStore.ts:5](src/extension/workspaceStore.ts#L5) defines a single
`'fcsViewer.state'` key, and every panel writes to it
([fcsViewerPanel.ts:601](src/extension/fcsViewerPanel.ts#L601)). Everything else about this
extension is scrupulously per-tab — sessions are keyed by `panelId`, the `panelId` rides in the
webview's own `setState` blob specifically so a restored tab reclaims its own sample list. This
one key breaks that: with two viewer tabs open, whichever persists last overwrites the other.

**Fix.** Once C1 is addressed the host-side mirror only needs to be in-memory (`this.uiState`),
since the webview's own `setState` already handles reload. Either drop the key entirely, or key
it by `panelId` alongside the sessions. Note `clearWorkspace` currently clears it
([workspaceStore.ts:107](src/extension/workspaceStore.ts#L107)), so removal needs a matching edit
there.

### C3. Matrix-cache pins are never released, so `CACHE_SIZE` is not enforced

`setActive` pins the newly active sample on every activation
([fcsViewerPanel.ts:389](src/extension/fcsViewerPanel.ts#L389)), and the only release is
`unpinAll()` from `SampleRegistry.dispose()`
([sampleRegistry.ts:257](src/extension/sampleRegistry.ts#L257)) — i.e. when the tab closes.
Meanwhile `touch()` refuses to evict a pinned entry *and* raises its own ceiling to
`Math.max(CACHE_SIZE, pinned.size)` ([matrixCache.ts:55-65](src/extension/matrixCache.ts#L55-L65)).

Consequence: click through ten samples in one tab and all ten parsed matrices stay resident,
against a documented `CACHE_SIZE = 3` chosen precisely because "a CyTOF matrix is ~31 MB"
([matrixCache.ts:24-29](src/extension/matrixCache.ts#L24-L29)). That is ~310 MB of extension-host
memory that will not be reclaimed until the tab is closed. The pin is well justified — every
re-slice depends on a cache hit — but its lifetime should be "while active", not "while open".

A secondary effect: `pinned` holds URI strings for files that may no longer be in `cache` at all,
so `pinned.size` can inflate the eviction ceiling even for entries that are not actually resident.

**Fix.** Unpin the outgoing sample in `setActive` before pinning the incoming one (roughly
`if (this.activeId !== undefined && this.activeId !== id) { this.registry.unpin(this.activeId); }`,
adding the single-id `unpin` that `SampleRegistry` currently lacks). Consider making
`pinned.size` count only resident keys.

### C4. Unbounded growth on `context.subscriptions` and the ack log

Two collections grow for the lifetime of the session with no bound:

- `closeTabFor` pushes a tab-change listener *and* a timer disposable onto
  `context.subscriptions` for every file opened
  ([fcsRedirectEditorProvider.ts:106](src/extension/fcsRedirectEditorProvider.ts#L106)). They are
  never removed — not even on the success path, where the listener has already disposed itself.
  Open a folder of 200 FCS files and that is 400 permanently retained entries.
- `FcsViewerPanel.acks` ([fcsViewerPanel.ts:53](src/extension/fcsViewerPanel.ts#L53)) appends one
  record per delivered slice and is never trimmed. It exists purely so integration tests can
  confirm the matrix arrived, and it ships in the packaged extension.

**Fix.** For the first, don't route these through `context.subscriptions` at all — the listener
already disposes itself on success and on timeout, so it just needs the timer cleared in both
paths and a panel- or call-scoped disposal instead. For the second, cap `acks` to the last handful
(the tests only ever check `acks.length > 0` and the most recent entry).

### C5. Extension manifest is missing publishing metadata

[package.json](package.json) has no `publisher`, `license`, `repository`, `keywords`, or `icon`.
`vsce package` refuses to build without `publisher`, and warns on a missing `license` and
`repository`. The integration suite currently hardcodes the placeholder identity this produces:

```ts
const EXT_ID = 'undefined_publisher.vscode-fcs-viewer';
```
— [extension.test.ts:8](src/test/integration/extension.test.ts#L8)

so the test breaks the moment a real publisher is set. Derive it from
`vscode.extensions.all` or read it from the manifest instead of hardcoding.

---

## 4. High

### H1. `fcs/sample` has no request id, so sample switches can land out of order

The slice path is carefully guarded: a monotonic `requestId` is echoed back and the reducer drops
superseded replies ([appReducer.ts:308-317](src/webview/state/appReducer.ts#L308-L317)), with the
reasoning that "a round-trip over a remote connection outlasts any debounce and a postMessage
cannot be unsent" ([useSliceRequests.ts:8-19](src/webview/state/useSliceRequests.ts#L8-L19)).

The full-payload path has no such guard. `webview/selectSample` messages are handled as
independent async chains — `handleMessage` is invoked per message with `void`
([fcsViewerPanel.ts:206-208](src/extension/fcsViewerPanel.ts#L206-L208)) and nothing serialises
them. `setActive` writes `this.activeId = id` *before* awaiting the load
([fcsViewerPanel.ts:366](src/extension/fcsViewerPanel.ts#L366)), so two quick selections can
interleave: A starts, B starts and wins `activeId`, then A's `fcs/sample` payload arrives last
and the webview displays A while the host believes B is active. The `fcs/samples` list posted
afterwards will disagree with what is on screen.

This is not hypothetical — a cold sample takes a file read plus a parse, so the window is wide.
`enqueue` serialises file *opens* but not sample *selection*.

**Fix.** Give `fcs/sample` the same treatment as `fcs/slice`: a panel-level monotonic activation
id, echoed in the payload, with the reducer ignoring a payload whose id is not the latest. Or
serialise `setActive` through a per-panel queue, reusing the `enqueue` primitive.

### H2. `buildPayload` mutates metadata owned by the cache

On a singular spillover matrix, `buildPayload` does
`meta.warnings.push(...warnings)` ([fcsViewerPanel.ts:501](src/extension/fcsViewerPanel.ts#L501)).
`meta` is `sample.dataset.metadata` — the object held by `matrixCache` and shared by every tab
showing that file. Re-activating the sample pushes the same warning again, so the warning list
grows on each visit and the webview's warnings panel accumulates duplicates.

**Fix.** Build the payload's warning list without writing back to the cached metadata; the
`ActiveSamplePayload` is already a fresh object per activation.

### H3. `requestedN` is recorded before the active-sample check

```ts
case 'webview/requestSlice': {
    this.requestedN = m.n;
    if (m.sampleId !== this.activeId) { return; }
```
— [fcsViewerPanel.ts:529-533](src/extension/fcsViewerPanel.ts#L529-L533)

A late request for a sample that is no longer active is correctly ignored for the purpose of
serving a slice, but its `n` has already been latched into `requestedN`, which
`buildPayload` uses to size the *next* sample's first slice
([fcsViewerPanel.ts:482](src/extension/fcsViewerPanel.ts#L482)). Swap the two lines.

### H4. Contour cards' Y channel is never checked for resolution

```ts
const refs = state.cards.flatMap((c) => (c.kind === 'scatter' ? [c.x.channel, c.y.channel] : [c.x.channel]));
```
— [App.tsx:56](src/webview/App.tsx#L56)

Contour cards have a `y` axis just as scatter cards do
([appReducer.ts:59-69](src/webview/state/appReducer.ts#L59-L69)), so this branch should be
`c.kind === 'histogram' ? [c.x.channel] : [c.x.channel, c.y.channel]`. As written, a contour card
whose Y channel is missing from the current sample is left out of the mapping report — the status
bar reports no problem while the card greys out. The `ContourCard` component itself resolves both
axes correctly, so this is only the reporting path, but that path is the user's only signal.

### H5. The oversized-file hint names a setting that does not control the limit

`FCS_TOO_LARGE` tells the user to "Raise `fcsViewer.maxFileSizeMB` if you really want to open it"
([data.ts:79-81](src/common/fcs/data.ts#L79-L81)), but the limit being enforced is
`options.maxValues`, which comes from the hardcoded
`DEFAULT_MAX_VALUES = 512_000_000` ([index.ts:17](src/common/fcs/index.ts#L17)). No configuration
setting feeds it — `maxFileSizeMB` is checked separately, on `stat.size`, before parsing
([fcsViewerPanel.ts:323-333](src/extension/fcsViewerPanel.ts#L323-L333)). A user who follows the
hint will raise the setting and hit the same error.

**Fix.** Either plumb a setting through to `maxValues`, or reword the hint to name the real
constraint.

### H6. Cancellation misses the expensive path

Two gaps in an otherwise well-plumbed cancellation story:

- The token is only polled in the slow per-event loop
  ([data.ts:124](src/common/fcs/data.ts#L124)). The typed-array fast path
  ([data.ts:114-121](src/common/fcs/data.ts#L114-L121)) — which is exactly the float32
  little-endian case that the 31 MB CyTOF fixture takes — runs to completion regardless. The
  progress notification `addSample` puts up is `cancellable: true`
  ([fcsViewerPanel.ts:336](src/extension/fcsViewerPanel.ts#L336)), so Cancel appears to do
  nothing on the largest files.
- `SampleRegistry.slice` calls `matrixCache.loadFile(entry.uri)` with no token
  ([sampleRegistry.ts:201](src/extension/sampleRegistry.ts#L201)), so a re-slice that misses the
  cache re-reads and re-parses uncancellably.

**Fix.** Add the same `(e & 8191) === 0` style poll to the transpose loop in the fast path (it is
already a two-level loop over `eventCount`), and thread the token through `slice`.

### H7. ESLint is too thin to catch any of the above

[eslint.config.mjs](eslint.config.mjs) enables four rules: `curly`, `eqeqeq`, `no-throw-literal`,
`semi`, plus an import naming convention. It loads `typescript-eslint` but applies none of its
rule sets, and there is no `eslint-plugin-react-hooks` — in a webview that depends heavily on
correct `useEffect`/`useMemo` dependency arrays
([useCardScales.ts:133](src/webview/views/plots/useCardScales.ts#L133),
[ScatterCard.tsx:72](src/webview/views/plots/ScatterCard.tsx#L72),
[useSliceRequests.ts:58](src/webview/state/useSliceRequests.ts#L58)).

Notably, `no-unused-vars` is off, which is why the dead code in M2 accumulated unnoticed.

**Fix, and this is the highest-leverage item in the review:**

```js
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
    { ignores: ['out/**', 'dist/**', 'node_modules/**', '.vscode-test/**'] },
    tseslint.configs.recommendedTypeChecked,
    { languageOptions: { parserOptions: { projectService: true } } },
    { files: ['src/webview/**/*.tsx'], ...reactHooks.configs['recommended-latest'] },
);
```

`recommendedTypeChecked` needs a project service and will surface findings on first run; worth the
one-off cleanup. The codebase is already written in a style that will pass most of it — the
`noUncheckedIndexedAccess`-style `!` assertions everywhere suggest strictness is welcome here.

---

## 5. Medium

### M1. A duplicated heuristic that has already diverged

Two implementations of the default arcsinh cofactor:

| | [fcsViewerPanel.ts:639](src/extension/fcsViewerPanel.ts#L639) | [transform.ts:133](src/common/fcs/transform.ts#L133) |
| --- | --- | --- |
| Name | `defaultCofactor` (private) | `defaultCofactorFor` (exported) |
| Mass-cytometer regex | `helios\|cytof\|fluidigm\|standard biotools` | same **plus** `xt` |
| No spillover, not mass | `5` | `F` + all-linear → `5`, else `150` |
| Used? | **Yes** | **No — dead** |

The shared, better-documented, more thorough version in `common/` is the one nothing calls. This
is the classic shape of a bug waiting to happen: the next person fixes one of them.

**Fix.** Delete the private copy and call `defaultCofactorFor(meta)`. It takes `FcsMetadata`,
which `buildPayload` already has in hand.

### M2. Dead code

Exported and never used anywhere outside its own file or the tests:

| Symbol | Location |
| --- | --- |
| `parseFcsMetadata` | [index.ts:20](src/common/fcs/index.ts#L20) |
| `isHostToWebview`, `isWebviewToHost` | [protocol.ts:100-106](src/common/protocol.ts#L100-L106) |
| `defaultCofactorFor` | [transform.ts:133](src/common/fcs/transform.ts#L133) — see M1 |
| `FcsViewerPanel.forget()` | [fcsViewerPanel.ts:626](src/extension/fcsViewerPanel.ts#L626) — its doc comment claims `FCS: Clear Workspace` uses it; that command calls `clearWorkspace` instead |
| `matrixCache.residentUris()` | [matrixCache.ts:191](src/extension/matrixCache.ts#L191) |
| `SampleRegistry.uriOf()`, `.size` | [sampleRegistry.ts:43-49](src/extension/sampleRegistry.ts#L43-L49) |
| `fcs/progress` message variant | [protocol.ts:79](src/common/protocol.ts#L79) — fully handled in the webview ([useHostMessages.ts:119](src/webview/state/useHostMessages.ts#L119)), never sent by the host |

Also: `labelFor` has two branches returning the identical expression
([scales.ts:60-63](src/webview/render/scales.ts#L60-L63)) — presumably one was meant to be a
different format.

The two unused type guards are worth *keeping* and wiring up rather than deleting — see M7.

### M3. `fcsViewerPanel.ts` carries five responsibilities

At 645 lines it is more than twice the next-largest host file, and it is the one place where the
clean separation practised everywhere else slips. It currently owns:

1. Panel lifecycle (create / revive / dispose)
2. A static registry of open panels plus focus tracking
3. Message routing — a 100-line `handleMessage` switch
4. Slice budgeting and clamping (`maxSliceBytes`, `budgetRows`, `buildSlice`)
5. Persistence and snapshotting
6. Test/debug hooks (`debugState`, `debugRevive`, `disposeAll`, `acks`)

Three of the Critical/High findings above (C1, C3, H1, H3) live in the seams between these
responsibilities, which is the usual symptom.

**Suggestion.** Extract the slice budget logic (`maxSliceBytes` / `budgetRows` / `buildSlice`) —
it is pure arithmetic over a channel count and a config value, and would then be unit-testable
without a VS Code host, which it currently is not. Extracting the message router is a second,
larger step. Static panel-registry state could move to a small `PanelManager` owned by
`activate()`.

### M4. `enqueue` lives in the wrong module

`enqueue` ([fcsRedirectEditorProvider.ts:19](src/extension/fcsRedirectEditorProvider.ts#L19)) is
the extension-wide serialiser for opening files — `extension.ts` imports it for five different
commands. It happens to be defined in the custom-editor provider because that is where the
five-files-dragged-at-once problem was first hit. Its own doc comment describes it as
serialising "across every entry point", which is a good clue that it does not belong here. Move
it to `src/extension/openQueue.ts` (or similar).

### M5. `matrixCache` is module-level mutable global state

Five module-scope mutable collections (`cache`, `inFlight`, `pinned`, `inProgress`, plus the
implicit ordering in `cache`) with a `clearMatrixCache()` test hook as the direct consequence
([matrixCache.ts:183-189](src/extension/matrixCache.ts#L183-L189)) — needed because tests cannot
otherwise get a clean slate, and called by two debug commands for the same reason.

The comments justify *process-wide sharing* convincingly (two tabs on the same file should parse
it once). They do not justify *module-global* state, which is a different thing: a single
instance owned by `activate()` and passed to `SampleRegistry` would share exactly as well, be
testable without a reset hook, and make the lifetime explicit. Not urgent — this works — but it
is the reason C3 was easy to introduce and hard to see.

### M6. `getNonce` uses `Math.random()`

[webviewHtml.ts:3-10](src/extension/webviewHtml.ts#L3-L10) builds the CSP nonce from
`Math.random()`. In practice the exposure is small — the webview loads exactly one local script
and `default-src 'none'` blocks everything else — but a CSP nonce is a security primitive and
should come from a CSPRNG. `crypto.randomUUID()` is already used a few files away for panel ids
([fcsViewerPanel.ts:128](src/extension/fcsViewerPanel.ts#L128)); `crypto.randomBytes(16).toString('base64')`
is the conventional form.

### M7. Host does not validate webview messages or check the protocol version

`handleMessage` receives `unknown` and casts:

```ts
this.panel.webview.onDidReceiveMessage((m: unknown) => { void this.handleMessage(m as WebviewToHost); })
```
— [fcsViewerPanel.ts:206-208](src/extension/fcsViewerPanel.ts#L206-L208)

A message with an unrecognised `type` reaches `assertNever` and throws inside a floating promise;
one with the right `type` and a missing field fails deeper in. `isWebviewToHost` exists for
exactly this and is unused (M2).

Separately, `PROTOCOL_VERSION` is posted by the webview and logged by the host
([fcsViewerPanel.ts:517](src/extension/fcsViewerPanel.ts#L517)) but never compared against the
host's own constant. Since both sides are built from the same source in the same `dist/`, a
mismatch can only happen if a stale webview survives an update — which is exactly the case a
version field is for. Cheap to add: log a warning and, if you want, show a "reload the viewer"
notice.

### M8. `hydrate()` stats persisted files one at a time

[fcsViewerPanel.ts:248-260](src/extension/fcsViewerPanel.ts#L248-L260) awaits
`vscode.workspace.fs.stat` inside a `for` loop. With eight persisted samples on a remote
filesystem that is eight serial round-trips on the restore path, which the code elsewhere treats
as latency-sensitive ("Hydration stats files, which is slow enough over a remote filesystem that
ready reliably wins the race" — [:513-515](src/extension/fcsViewerPanel.ts#L513-L515)). The stats
are independent; `Promise.all` over the list, then a sequential `adopt` pass to preserve order,
gets the same result in one round-trip.

### M9. `SampleRegistry.has()` is a linear scan

[sampleRegistry.ts:51-59](src/extension/sampleRegistry.ts#L51-L59) iterates every entry
stringifying URIs. Called from `add`, `adopt`, and `addSample`. With a realistic sample count
this is irrelevant to performance — flagging it only because a `Map<string, string>` keyed by
`uri.toString()` alongside `entries` is strictly simpler code, not just faster.

### M10. Debug commands ship in the packaged extension

Five `debug*` commands are contributed with `enablement: "false"` and `when: false` in the
command palette, which correctly hides them from users. They remain callable via
`vscode.commands.executeCommand` from any other extension in the window, and `fcsViewer.debugReset`
destroys persisted state ([extension.ts:209-213](src/extension/extension.ts#L209-L213)).

The trade-off is explicitly reasoned about in the code ("Named-workspace commands are all
prompts, which a test host cannot drive"), and this is a common and defensible pattern. Worth
noting rather than changing; if you want them gone from releases, an esbuild `define` flag
guarding the registrations would do it without complicating the test setup.

### M11. Integration tests poll, and duplicate their helper

An identical ~12-line `until()` polling helper is copy-pasted into three suites
([restore.test.ts:41](src/test/integration/restore.test.ts#L41),
[namedWorkspace.test.ts:44](src/test/integration/namedWorkspace.test.ts#L44),
`openRedirect.test.ts`), and `realFile.test.ts` open-codes a fourth variant as a 600-iteration
loop. All four poll `fcsViewer.debugState` on a 100 ms timer, which is why every suite carries a
60 s timeout.

**Fix.** Move `until()` to a shared `src/test/integration/helpers.ts`. Longer term, an
event-based hook (a debug command that resolves a promise on the next ack) would let these tests
drop from seconds to milliseconds, but the shared helper is the cheap win.

---

## 6. Low — preference

### L1. "Copy to clipboard" copies only the visible viewport

`copyVisible` iterates `rowStart..rowEnd` — the virtualised window — and `colStart..colEnd` is
not used, so it takes all visible columns but only the ~30 rows currently rendered
([DataTableView.tsx:147-157](src/webview/views/DataTableView.tsx#L147-L157)). The tooltip is
honest about it ("Copy the visible rows and columns as tab-separated text"), and the row count
depends on the window height, which makes the result non-reproducible. Given `TODO.md` lists
clipboard export as an MVP item, copying the whole subsample (or offering both) is probably what
was meant.

### L2. Sentinel strings in unions with structured values

`AxisConfig.domain: 'auto' | [number, number]`
([appReducer.ts:30](src/webview/state/appReducer.ts#L30)) and
`binCount: number | 'auto'` ([appReducer.ts:74](src/webview/state/appReducer.ts#L74)) mix a magic
string with a structured value, so every consumer does `=== 'auto'` checks. A discriminated
`{ mode: 'auto' } | { mode: 'manual', range: [number, number] }` is more idiomatic and survives a
future third mode. Entirely taste; the current form is compact and the persistence layer already
handles it.

### L3. `updateCard`'s patch type is not type-safe

```ts
| { type: 'updateCard'; id: string; patch: Partial<Omit<ScatterCardConfig, 'kind'>> & Partial<Omit<ContourCardConfig, 'kind'>> & Partial<Omit<HistogramCardConfig, 'kind'>> }
```
— [appReducer.ts:141](src/webview/state/appReducer.ts#L141)

The intersection of three partials accepts any field from any card kind, so
`dispatch({ type: 'updateCard', id, patch: { pointSize: 3 } })` type-checks against a histogram
and the reducer's `{ ...c, ...action.patch } as CardConfig` cast
([appReducer.ts:381](src/webview/state/appReducer.ts#L381)) lets it through. Per-kind actions
(`updateScatter` / `updateContour` / `updateHistogram`) would be safe, at the cost of three
similar branches. The `as CardConfig` cast is the tell that the types are being fought here.

### L4. `nextCardId` mixes a counter and `Math.random()`

[appReducer.ts:175-178](src/webview/state/appReducer.ts#L175-L178) —
`card-${++cardCounter}-${Math.floor(Math.random() * 1e6).toString(36)}`. `crypto.randomUUID()` is
available in the webview and needs no module-level counter (which, incidentally, does not reset
between samples, so ids grow monotonically across the session — harmless).

### L5. Repository hygiene

- `vsc-extension-quickstart.md` is still the unmodified generator template. Delete it, or replace
  it with the project's own contributor notes — it is the one file in the repo that does not
  reflect this codebase.
- The README documents the extension well but embeds no screenshots, even though
  `scripts/preview.mjs` exists specifically to generate them and five are sitting in `preview/`
  (gitignored, so untracked). For a visualisation extension, one committed screenshot in the
  README and one as the marketplace `icon` would do more for adoption than anything else on this
  list. This pairs with C5.
- `.gitignore` covers `data/` and `preview/`, neither of which is tracked — consistent, and the
  puppeteer-on-demand arrangement is documented in both the script and the README. No issue;
  noting it only because the untracked `data/` is what gates the tests in L6.

### L6. No CI, and the best tests are gated off

There is no workflow file. More importantly, the assertions with the most value — the real-file
invariants in [realFile.test.ts](src/test/unit/realFile.test.ts) that check exact channel names,
event counts, and the `$FIL`-parity property that the whole delimiter algorithm exists to
protect — are gated on `FCS_TEST_FILE` pointing at gitignored ~40 MB fixtures, so they never run
automatically. The comment says so plainly, which is good, but it means the parser's regression
net is not actually deployed.

[makeFcs](src/test/unit/fixtures/makeFcs.ts) is already a capable synthetic-file builder. A
committed fixture exercising the awkward cases (empty `$FIL` via doubled delimiter, non-byte-aligned
`$PnB`, a `SPILL` with partial channel coverage, `$BEGINDATA` offset repair) would give the same
protection at a few KB, and would run in CI. A minimal workflow — `npm run check-types`,
`npm run lint`, `npm run test:unit`, plus `xvfb-run npm test` — would catch most of what is in
this document.

---

## 7. Test coverage gaps

Beyond L6, three specific things nothing currently asserts, each corresponding to a finding above:

- **Named-workspace UI round-trip (C1).** The `hasUi` field is already reported by
  `debugWorkspace 'list'` and already declared in the test's interface — it just needs an
  assertion, plus a webview-side check that the restored card list matches what was saved.
- **Multi-tab isolation of UI state (C2).** Two panels, distinct card layouts, reload, both
  correct. `debugRevive` and `debugState` already give you everything needed to write it.
- **Cache eviction and pinning (C3).** `debugState` already reports `resident` per panel
  ([fcsViewerPanel.ts:157](src/extension/fcsViewerPanel.ts#L157)). A test that activates five
  samples and asserts `resident.length <= 3` would have caught the pin leak directly.

The existing suites are otherwise well constructed — `makeFcs` is a genuinely good fixture
builder, the restore tests exercise the real persistence path via `debugRevive` rather than
mocking it, and the `.vscode-test.mjs` launch args document exactly why each one is needed.

---

## 8. If you only do five things

1. **C1 + C2** — wire up the named-workspace UI round-trip. It is three small edits and it is the
   difference between the feature working and silently discarding the user's work.
2. **C3** — unpin the outgoing sample. One line, and it bounds extension-host memory to the
   documented `CACHE_SIZE`.
3. **H7** — turn on `typescript-eslint`'s type-checked recommended set and
   `eslint-plugin-react-hooks`. This is what stops the next M2 and the next H4.
4. **C5** — add `publisher`, `license`, `repository` to the manifest and stop hardcoding the
   extension id in tests. Required before any release.
5. **H1** — give `fcs/sample` a request id. The slice path already proves you know the pattern;
   the payload path needs the same protection and it is a user-visible wrong-data bug.

M1 (the diverged cofactor heuristic) and H3 (the two swapped lines) are both single-line fixes
worth folding in while you are in those files.
