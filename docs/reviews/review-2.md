# Code Review — FCS Viewer, round two

Follow-up to [REVIEW.md](REVIEW.md). Scope: the whole tree as it now stands, with attention to
(a) whether the 29 round-one findings were actually resolved, and (b) the new work — UMAP
projections and the extension-host refactor.

The changes landed by amending the existing commits, so `git log` is still at `f1b6de4` and
`git diff HEAD` is empty; there is no diff to read and this review is of the tree as it is.
Source has grown from ~7,100 to ~12,600 lines, tests from ~1,400 to ~2,100.

Verified by running, read-only: `tsc --noEmit` on both projects is clean, `eslint src` is clean,
`npx vsce ls` exits 0 and packs 7 files.

Priority tags are as before: **Critical** / **High** / **Medium** / **Low**.

---

## 1. Summary

| Dimension | Round one | Now | What moved |
| --- | --- | --- | --- |
| Architecture | A− | **A** | The panel class no longer owns five jobs. `PanelManager` owns lifetime, `panelMessages` owns routing over a named interface, `sliceBudget` is pure and tested, `MatrixCache` is an instance. Module-global state is gone. |
| Implementation | B+ | **A−** | Every High from round one is fixed, most with the reasoning written down. Two new defects, both in seams the refactor created. |
| Documentation | A | **A** | Already the strongest dimension; the ESLint config comment and `embedding.ts` raise it further. |
| Tests | B− | **A−** | `reviewFindings.test.ts`, four new unit suites, one shared `until()`, and CI. The gated real-file tests now have synthetic stand-ins that actually run. |
| Production readiness | C | **B** | Held back by one thing only: the manifest still has no `publisher` or `license`, so `vsce package` cannot run. |

**27 of 29 round-one findings are resolved.** The two that are not are C5 (manifest metadata) and
half of M2 (one dead chain). Several fixes went beyond what was asked, and two of them are bugs
the developer found without prompting.

Twelve new findings below: two High, four Medium, six Low. Both High items are regressions
introduced by the refactor, in exactly the places a refactor of this shape puts them — one is
behaviour that moved when a call site changed owner, the other is an ordering hazard next to the
one the refactor was fixing. Neither is structural.

---

## 2. What this round got right

**The host split is the real win.** `panelMessages.ts` is a plain function over a
`PanelMessageContext` interface rather than a method reaching into private fields, and the comment
says why that mattered: *"Naming that surface explicitly is most of the value of moving it out"*
([panelMessages.ts:7-15](src/extension/panelMessages.ts#L7-L15)). That is the right reason. The
side effect is that `sliceBudget.ts` and `embeddingSignature` are now pure functions with unit
tests, where before the only way to reach those numbers was to launch a VS Code host and drive a
webview — [sliceBudget.test.ts](src/test/unit/sliceBudget.test.ts) says so in its own header.

**The ESLint decision is better engineering than what I asked for.** I said "turn on
`recommendedTypeChecked`". The response measured it instead and wrote the result into the config:
~30 real findings, enumerated by category, with the one alarming number (170
`no-floating-promises`) traced to `describe`/`it` in `node:test` files, and the conclusion deferred
to TODO with those counts attached
([eslint.config.mjs:5-22](eslint.config.mjs#L5-L22)). Answering a review item with data and a
documented deferral is the correct move, and it is rarer than it should be.

**`reviewFindings.test.ts` is framed correctly.** *"Each of these fails against the code as
reviewed, which is the point: the features they cover were all 'working' as far as the existing
suites could tell"* ([reviewFindings.test.ts:18-22](src/test/integration/reviewFindings.test.ts#L18-L22)).
The H1 test in particular does the hard part properly — it forces a *genuine* race by evicting the
cache and pitting a deliberately large file against a tiny one, rather than hoping two calls
interleave ([reviewFindings.test.ts:126-161](src/test/integration/reviewFindings.test.ts#L126-L161)).
The C3 test's comment about why opening files is not enough (`setActive` defers until ready, so
the early opens never pin and the leak stays hidden) shows the first version of the test didn't
work and why.

**Two bugs found unprompted, both of the worst kind.**

- `labelFor` — I filed the duplicated branch as a cosmetic nit. It was a real defect: the upper
  branch stopped at 1e6 and fell through to the same plain formatting as small numbers, so one
  axis read `100k` while the next read `1,000,000`, on a range cytometry hits routinely
  ([scales.ts:52-62](src/webview/render/scales.ts#L52-L62)).
- Compensation was forced off for samples without a spillover matrix and stayed off after
  switching back — raw plots with nothing indicating anything had changed. It is now a global
  intent that survives the switch, with a *Not compensated* status chip naming the file and the
  three keywords searched ([StatusBar.tsx:68-82](src/webview/components/StatusBar.tsx#L68-L82)),
  and a regression test. That is a wrong-plot-that-looks-right, which is the category this
  codebase is otherwise most careful about.

**`embedding.ts` is the best new file.** The standardisation comment earns its length: UMAP's
neighbour graph is Euclidean, raw FSC runs to 10⁵ while an arsinh marker spans single digits, so
without scaling *"the embedding is essentially a plot of FSC and the markers contribute rounding
error"* ([embedding.ts](src/webview/compute/embedding.ts)). It also handles the zero-variance
channel (an unused detector) rather than dividing by zero and poisoning every distance with a
single NaN. And `embeddingSignature` deliberately excludes colour, colormap and point size, with
the guarantee stated: recolouring must not discard a computation that took seconds.

---

## 3. Round-one findings: resolved

| # | What it was | Status |
| --- | --- | --- |
| **C1** | Named-workspace UI wired at neither end | **Fixed.** `setUiState` connected ([panelMessages.ts:183](src/extension/panelMessages.ts#L183)); `host/restoreState` posted before activation, with the reason — the other order renders every card against no data and then re-renders it ([panelMessages.ts:80-87](src/extension/panelMessages.ts#L80-L87)). `debugSnapshot` now exposes `uiCards`, which is what makes the round-trip assertable from the host. |
| **C2** | One global `UI_STATE_KEY` in a per-tab design | **Fixed.** The key is deleted outright, not made per-panel — grep finds zero references. Held in memory, and the comment explains that the webview's own `setState` already covers a reload. |
| **C3** | Pins never released | **Fixed, and then some.** `unpin` on switch ([fcsViewerPanel.ts:327-329](src/extension/fcsViewerPanel.ts#L327-L329)) *plus* `ceiling()` counting only pins on resident entries ([matrixCache.ts:62-76](src/extension/matrixCache.ts#L62-L76)) — I flagged the second as a secondary effect and did not ask for it. See N2 for the interleaving that survives. |
| **C4** | Unbounded `context.subscriptions` and `acks` | **Fixed.** Both paths self-dispose off `context.subscriptions`, with the 400-entries-for-200-files arithmetic in the comment ([fcsRedirectEditorProvider.ts:77-101](src/extension/fcsRedirectEditorProvider.ts#L77-L101)); `acks` capped at `MAX_ACKS = 20`, noting that readers only ever want the most recent. |
| **C5** | No `publisher` / `license` | **Not fixed** — see N6. |
| **H1** | `fcs/sample` had no request id | **Fixed.** `activationId` on the payload, `superseded()` checked at every resumption point, dropped in the reducer, `PROTOCOL_VERSION` bumped to 3. |
| **H2** | `buildPayload` mutated cached metadata | **Fixed.** Warnings returned and unioned at the call site, with the shared-array reasoning recorded ([fcsViewerPanel.ts:453-460](src/extension/fcsViewerPanel.ts#L453-L460)). |
| **H3** | `requestedN` set before the active check | **Fixed.** Guard first, and a comment saying the order is the point. |
| **H4** | Contour Y never resolution-checked | **Fixed.** Switch over every kind, including UMAP's whole channel list, and the comment records what the old branch got wrong ([App.tsx:56-69](src/webview/App.tsx#L56-L69)). |
| **H5** | `FCS_TOO_LARGE` named the wrong setting | **Fixed.** Message names the real ceiling; the hint now gives the GB the decode would need, and a comment records that `maxFileSizeMB` is deliberately *not* named ([data.ts:127-137](src/common/fcs/data.ts#L127-L137)). |
| **H6** | Cancellation missed the fast path | **Fixed.** Polls per channel pass in the typed-view branch, with the diagnosis — *"made Cancel do nothing on exactly the files slow enough for anyone to press it"*. `slice` threads a token, and a superseding request now cancels the in-flight one. |
| **H7** | ESLint too thin | **Fixed, better.** See §2. |
| **M1** | Diverged cofactor heuristic | **Fixed.** One `defaultCofactorFor`; the panel's private copy is gone. |
| **M2** | Dead code | **Mostly.** `parseFcsMetadata`, `residentUris`, `uriOf` deleted; both type guards now used. One chain survives — N7. |
| **M3** | 645-line panel class | **Fixed.** See §2. |
| **M4** | `enqueue` in the wrong module | **Fixed.** `openQueue.ts`, with the "only where the problem was first hit" note. |
| **M5** | Module-global `matrixCache` | **Fixed.** `MatrixCache` instance owned by `activate()`; the `clearMatrixCache` test hook is gone, which was the point. |
| **M6** | `Math.random()` CSP nonce | **Fixed.** `randomBytes(16)`. |
| **M7** | No message validation, version unchecked | **Fixed.** Both guards used; the version is compared *and* surfaced to the user as "this tab is out of date"; and the floating rejection is caught at the listener ([fcsViewerPanel.ts:90-101](src/extension/fcsViewerPanel.ts#L90-L101)). |
| **M8** | Serial `stat` on restore | **Fixed.** `Promise.all` for the stats, adoption still sequential because it assigns sidebar order — the distinction is called out. |
| **M9** | Linear URI scan | **Fixed.** `byUri` map, kept in step in `add`/`adopt`/`remove`. |
| **M10** | Debug commands ship | Unchanged by design; see N12. |
| **M11** | Duplicated `until()` | **Fixed.** [helpers.ts](src/test/integration/helpers.ts), and its header names the copy-paste as the reason every suite carried a 60 s timeout. |
| **L1** | Copy took only the viewport | **Fixed.** `copyAll` takes every row of the subsample and the button states the count. |
| **L3** | `updateCard` accepted any field | **Fixed.** Per-kind actions; `updateCard` narrowed to `title`/`span`. The action-type comment records the old hole. |
| **L4** | `Math.random()` card ids | **Fixed.** `crypto.randomUUID()`. |
| **L5** | Repo hygiene | **Partly.** README rewritten and genuinely good. `vsc-extension-quickstart.md` still present; still no `icon`. |
| **L6** | No CI, best tests gated | **Fixed.** [ci.yml](.github/workflows/ci.yml) runs check-types, lint, unit, `xvfb-run npm test` and a package check, with a comment explaining what the synthetic fixtures stand in for. [offsets.test.ts](src/test/unit/offsets.test.ts) is exactly the coverage suggested, for the offset-repair path the gated real-file tests were the only cover for. |

L2 (sentinel strings in unions with tuples) was preference and is unchanged. Not re-raised.

---

## 4. New findings

### High

#### N1. `disposeAll()` no longer closes the webview tabs

`PanelManager.disposeAll()` calls `p.dispose()`
([panelManager.ts:165-172](src/extension/panelManager.ts#L165-L172)), and
`FcsViewerPanel.dispose()` never disposes the underlying panel
([fcsViewerPanel.ts:588-603](src/extension/fcsViewerPanel.ts#L588-L603)). The pre-refactor code
called `p.panel.dispose()`, which closed the tab and let `onDidDispose` drive the cleanup. Grep
confirms there is no `panel.dispose()` left anywhere in `src/extension/`.

So `fcsViewer.debugCloseTabs` and `fcsViewer.debugReset` now leave a live webview on screen whose
message listener has been disposed and which the manager has forgotten — a tab that looks like a
viewer and answers nothing. The comment on `debugCloseTabs` ("Closes tabs but deliberately leaves
the persisted sessions alone, which is what a window reload looks like") is no longer true of the
first half.

This is a call-site behaviour change that moved when ownership moved, which is the characteristic
refactor regression. Nothing catches it:
[restore.test.ts:78,118](src/test/integration/restore.test.ts#L78) calls `debugCloseTabs` and then
`debugRevive` with no `closeAllEditors` between, so the window reload it simulates leaves two tabs
where a real reload has one — and every assertion goes through `debugState`, which only sees
manager-tracked panels. The suites' `closeAllEditors` in setup and teardown mops up the orphans
elsewhere, which is precisely the kind of masking `reviewFindings.test.ts` was written to call out.

**Fix.** Add a `close()` to `FcsViewerPanel` that disposes the underlying `WebviewPanel`, and call
that from `disposeAll()`. Guard against re-entry, since `onDidDispose` will then call `dispose()`
back — a `disposed` flag, or dropping the listener before disposing. Worth asserting in
`restore.test.ts` that the tab count returns to zero, since that is the property the test needs to
be true for its premise to hold.

#### N2. The pin leak survives under exactly the interleaving H1 was about

`setActive` pins the incoming sample at
[fcsViewerPanel.ts:371](src/extension/fcsViewerPanel.ts#L371) — *before* the `buildPayload` await
— and the `superseded()` early return two lines later
([:374-376](src/extension/fcsViewerPanel.ts#L374-L376)) leaves that pin in place.

Trace two overlapping selections, A then B:

1. A enters, `activeId` is undefined or something else, passes its first `superseded()` check.
2. B enters, sets `activeId = B`, and unpins A — which **has not pinned yet**, so the unpin is a
   no-op.
3. A resumes after its `load` await, calls `registry.pin(A)` at line 371, then hits
   `superseded()` at 374 and returns.

A is now pinned with `activeId === B`. No later `setActive` will unpin it, because the unpin at
line 327 only ever targets the *current* `activeId`. The pin survives until the tab closes — which
is C3 again, reachable through the same race H1 fixed.

The C3 regression test cannot see this: it awaits each selection to completion
([reviewFindings.test.ts:79-82](src/test/integration/reviewFindings.test.ts#L79-L82)), which is
the serial path. The H1 test does create the overlap but asserts on ack ordering, not on
`resident`.

**Fix.** Move `registry.pin(id)` below the last `superseded()` check, or unpin on that early
return. The C3 test's assertion (`resident.length <= 3`) added to the end of the H1 test would
cover it.

### Medium

#### N3. `PERSISTED_VERSION` was not bumped when a card kind was added

Still 3 ([persistence.ts:4](src/webview/state/persistence.ts#L4)) after `umap` joined
`CardConfig`. `migrateCard` handles the new kind correctly in *this* build — the `case 'umap':
return card` arm is there and right
([persistence.ts:70-78](src/webview/state/persistence.ts#L70-L78)).

The problem is the other direction. A workspace saved by this build carrying a UMAP card is
stamped version 3, so an older build accepts it (`saved.version > PERSISTED_VERSION` passes),
takes `migrateCard`'s `default:` branch, and calls `axis(card.y)` on a card that has no `y` —
throwing on `a.transform` of `undefined`. The version range check in `coerce` exists precisely so
an old reader can refuse a blob it does not understand; leaving the stamp at 3 after a
shape-widening change disables it.

Downgrades are rare, so this is Medium rather than High. But the fix is a one-character change to
a constant that already has a migration path built around it.

#### N4. `coerce` validates the envelope but not the cards

`saved.cards` is passed straight through as `CardConfig[]`
([persistence.ts:113](src/webview/state/persistence.ts#L113)); only `version` and the presence of
`cards` are checked. A card with `kind: 'umap'` and no `channels` — from a truncated write, a
hand-edited blob, or N3's downgrade path — reaches `UmapCard`, where
`config.channels.map` throws.

Where it throws matters. The `host/restoreState` path is inside the message handler's try/catch
and surfaces as an error message. The webview's *own* restore in
[App.tsx:29-38](src/webview/App.tsx#L29-L38) is not wrapped, so a corrupt `setState` blob throws
during an effect and blanks the panel with nothing said.

**Fix.** A per-kind shape check in `migrateCard`, dropping cards that do not validate. That
matches the posture `loadSessions` and `loadWorkspaces` already take on the host side — *"Never
throws: a corrupt entry is dropped rather than blocking the command"* — and the webview's
persistence is the one store that does not follow it.

#### N5. UMAP's cofactor is neither configurable nor tied to the user's default

`UmapCard` derives the arsinh cofactor from the file alone:
`defaultCofactorFor(data.metadata)` ([UmapCard.tsx:42](src/webview/views/plots/UmapCard.tsx#L42)).
It ignores `state.defaults.cofactor` and the per-axis cofactor every other card exposes in the
inspector.

So a user who tunes arsinh for their scatter plots — a normal thing to do, and the reason the
control exists — gets a UMAP built in a different space from every other card on the page, with
nothing indicating it. Given that `embedding.ts` is otherwise scrupulous about exactly this
category ("silently wrong rather than visibly broken"), the omission stands out.

**Fix.** Feed `state.defaults.cofactor` through, or expose it on the UMAP card. Either way,
`embeddingSignature` must gain the cofactor — it currently keys on channel *indices* only
([embedding.ts](src/webview/compute/embedding.ts)), so a cofactor change would not invalidate the
cached embedding and the plot would silently keep the old one.

#### N6. CI does not guard C5, and the next review file ships in the .vsix

Two manifest points, grouped because they are both one line each:

- **C5 is still open.** No `publisher`, `license`, `repository` or `icon` in
  [package.json](package.json). The CI step added for this is `npx vsce ls` — which I ran, and it
  exits 0 without a publisher. `vsce package` is the command that refuses, so the step as written
  passes today and will keep passing right up to the first release attempt. Changing it to
  `npx vsce package --out /tmp/check.vsix` closes the gap. (For a visualisation extension, the
  `icon` is also the highest-leverage remaining item for adoption — `scripts/preview.mjs` already
  generates the screenshots.)
- **`.vscodeignore` excludes `REVIEW.md` by literal name**
  ([.vscodeignore](.vscodeignore)), so this file is in the packed set — `vsce ls` lists
  `REVIEW2.md` today. Use `REVIEW*.md`.

### Low

#### N7. `ResolverIndex.signature` and `panelSignature` are still dead

Nothing reads `.signature` — grep returns zero hits
([channelResolver.ts:22-38](src/webview/state/channelResolver.ts#L22-L38)). It survived the
dead-code sweep because `buildIndex` references `panelSignature`, so both look used; the chain just
terminates in a field nobody consumes. `no-unused-vars` cannot see this shape.

TODO keeps it as scaffolding for the manual-remapping UI ("the resolver and its persistence keyed
by panel signature already exist"), which is fair — but `manualMapping` is keyed by channel name,
not by signature, so it is not currently wired to the thing it was built for. Either drop it or
note in the type that it is unused pending that feature.

#### N8. Spreading a typed array into `Math.min` couples correctness to the cell cap

`pointDensity(x, y, [Math.min(...x), Math.max(...x)], [Math.min(...y), Math.max(...y)])`
([UmapCard.tsx:115](src/webview/views/plots/UmapCard.tsx#L115)). Safe at `UMAP_MAX_CELLS = 5000`;
throws `RangeError: too many arguments` somewhere north of ~65k.

This is the one place the cap is load-bearing for *correctness* rather than performance, and
nothing at either site says so — `UMAP_MAX_CELLS`' own comment is entirely about neighbour-graph
cost ([appReducer.ts:291-298](src/webview/state/appReducer.ts#L291-L298)), so raising it looks like
a pure speed/quality trade. A plain loop, or letting `pointDensity` derive its own extent when the
caller passes none, removes the coupling.

#### N9. Stale comment on `MatrixCache.clear()`

[matrixCache.ts:206](src/extension/matrixCache.ts#L206) says *"Used by FCS Viewer: Discard
Remembered Samples"* — a command that was deliberately removed this round. Its callers are now
`debugEvictCache` and `debugReset`.

#### N10. Orphaned JSDoc in `data.ts`

Inserting `throwIfCancelled` left `readBits`' doc comment stranded above it
([data.ts:16-24](src/common/fcs/data.ts#L16-L24)), so `throwIfCancelled` carries two comments and
`readBits` — the one that actually needs explaining — has none.

#### N11. The mapping report and the UMAP card disagree about `colorBy`

`App.tsx` includes a UMAP's `colorBy` in the refs it resolves
([App.tsx:65](src/webview/App.tsx#L65)), so a colour channel the sample lacks raises the status-bar
"N channels missing" chip, whose detail reads *"Cards using them are greyed out; pick another
channel in the inspector"*. But `UmapCard` deliberately does **not** grey out for a missing
`colorBy` — it falls back to density and says so inline
([UmapCard.tsx:172-178](src/webview/views/plots/UmapCard.tsx#L172-L178)), which is the better
behaviour.

The two are individually right and jointly contradictory. Either exclude `colorBy` from the report
(projection channels do gate the card, so they belong there) or split the chip's wording.

#### N12. The debug command surface grew from five to seven

`debugSelect` and `debugEvictCache` are new, and unlike the read-only `debugState` both mutate real
state. All seven are still `enablement: false` with `when: false` in the palette, and still
reachable via `executeCommand` from any extension in the window. Noted rather than urged — the
trade-off is the same one round one accepted, and the esbuild-`define` option still applies if it
ever matters.

---

## 5. On the UMAP feature specifically

It is the largest new surface and it is mostly very good. N5 and N8 are its only real defects; the
rest of what follows is credit.

The time-slicing is right, and the reasoning is specific rather than hand-waved: `fitAsync` was
evaluated and rejected because an epoch costs ~1.3 ms, so one macrotask each *"spends more time in
the scheduler than in UMAP"*, and because it hides `initializeFit` — the genuinely unyieldable part
— inside the same call, *"leaving no chance to paint a 'preparing' state before the window stalls
for it"* ([useUmapEmbedding.ts:7-22](src/webview/state/useUmapEmbedding.ts#L7-L22)). Driving
`initializeFit` + `step()` directly with a 12 ms budget per frame is the correct answer, and the
progress states the user sees fall out of it.

Skipping `transform()` is the right trade and is argued as one: fitting a subsample then projecting
the rest costs ~half a second of unyieldable nearest-neighbour search, and the card plots exactly
the cells it embedded and says how many. Compare the alternative — a plot silently showing points
that were never part of the fit.

The state design is careful in a way that is easy to get wrong. Only the asynchronous run is React
state; idle, cached and the initial preparing state are all *derived* from the signature, which is
what stops the effect setting state synchronously on every render. The effect keys off the
signature string alone, with the `latest` ref carrying the rebuilt request object, so *"restarting
a fit because an array got a new identity"* cannot happen — and a `SampleData.withStats` arriving
mid-run does exactly that, since it produces a fresh object with an unchanged signature.

Two smaller decisions worth noting. `rows` is a prefix of `indices` — the rows every other card is
drawing right now — not `data.rows(n)`, with the comment explaining that lowering the global
subsample does not shrink the slice, so the latter *"would happily hand back cells no other card is
showing"* ([UmapCard.tsx:50-54](src/webview/views/plots/UmapCard.tsx#L50-L54)). And
`projectionRows` / `colorChoices` keep a configured channel visible and flagged when the active
sample lacks it, because *"the card refuses to compute until that channel is removed, and an
invisible checkbox cannot be unticked"*
([channelResolver.ts:103-112](src/webview/state/channelResolver.ts#L103-L112)) — a UI failure mode
most people meet only after shipping it.

The axes are drawn without ticks because UMAP coordinates have no units, and the README says
plainly that the result is not comparable with a t-SNE figure from another tool. For a scientific
audience that is the difference between a plot and a misleading plot.

---

## 6. Shortlist

1. **N1** — make `disposeAll()` actually close the tabs, and assert the tab count in
   `restore.test.ts` so its premise holds.
2. **N2** — move the pin below the last supersession check. One line, and it closes the last
   corner of C3.
3. **N6** — `publisher` + `license`, make the CI step `vsce package`, and change `REVIEW.md` to
   `REVIEW*.md` in `.vscodeignore`. Nothing here is more than a line, and the first is the only
   thing standing between this and a releasable extension.
4. **N3** — bump `PERSISTED_VERSION` to 4.

N9, N10 and N11 are comment-and-one-line fixes worth folding in while in those files.

---

## 7. Closing note

Round one found a half-wired feature, a memory leak, and a thin lint config. All three are gone,
and the two structural suggestions — extract the message router and the slice budget, give the
cache an owner — were taken further than proposed and for the stated reason that *"nothing owned
the lifetime"* is why the pin leak was easy to introduce and hard to see
([matrixCache.ts:42-49](src/extension/matrixCache.ts#L42-L49)). That diagnosis is correct, and N2
is the residue of it: the last place where a lifetime spans an `await` without a guard.

The codebase is now in the shape where the remaining work is a manifest field and four one-line
fixes. The habit visible throughout — writing down the alternative that was rejected, and the
measurement that decided it — is what makes this reviewable at all at 12,600 lines, and it is worth
keeping as the thing scales.
