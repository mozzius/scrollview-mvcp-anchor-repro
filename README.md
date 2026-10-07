# ScrollView `maintainVisibleContentPosition`: two ways the iOS anchor goes wrong

`maintainVisibleContentPosition` (mVCP) on iOS (New Architecture) works in two
steps around each mounting transaction. Before the mount it picks an anchor: the
first content subview that is at least partly visible. After the mount it moves
the scroll offset by however far that anchor moved. Both steps live in
`RCTScrollViewComponentView.mm`. This repo reproduces two bugs in them, and has
one upstream issue draft for each.

| | Spacer anchor | Clipped anchor |
| --- | --- | --- |
| What goes wrong | After a prepend, a VirtualizedList spacer can be partly visible and becomes the anchor. When the spacer is re-estimated, its origin stays put while everything after it moves, so mVCP corrects nothing. | `main` aborts the correction when the anchor is no longer a subview of the content view. With `removeClippedSubviews`, any prepend taller than about a screen detaches the anchor just before that check. |
| Effect in this repro | The row the user was looking at jumps 962pt up and off screen | The visible rows are pushed down by the whole 2400pt prepend |
| Affected | 0.87.1, 0.88.0-rc.4, `main` | 0.88.0-rc.4 and `main` only (a regression from [#57294](https://github.com/react/react-native/pull/57294); 0.87.1 is fine) |
| Issue draft | [`ISSUE-spacer-anchor.md`](ISSUE-spacer-anchor.md) | [`ISSUE-clipped-anchor.md`](ISSUE-clipped-anchor.md) |
| Demo | [`evidence/ios-spacer-anchor.mp4`](evidence/ios-spacer-anchor.mp4) | [`evidence/ios-clipped-anchor.mp4`](evidence/ios-clipped-anchor.mp4), [`evidence/ios-clipped-anchor-0.88.0-rc.4.mp4`](evidence/ios-clipped-anchor-0.88.0-rc.4.mp4) |

A third problem, a teleport when the anchor is unmounted in the same
transaction, reproduces on 0.87.1 but is already fixed on `main` by #57294. It
is covered in [Background: the unmounted anchor on 0.87.1](#background-the-unmounted-anchor-on-0871),
and not drafted as an issue.

- **Found in:** the Bluesky app, restoring a feed position and prepending newer
  posts above the reader.
  <!-- TODO(samuel): link the social-app PR that carries these fixes as a patch, as the spacer-ring repro does. -->

## Environment

| | |
| --- | --- |
| react-native | 0.87.1 (also checked on an unmodified 0.88.0-rc.4 build; `main` at 73f4204 has the same code as the RC) |
| react | 19.2.3 |
| Architecture | New (Fabric), Hermes |
| Tested on | iOS Simulator, iPhone 17 Pro, iOS 26.5 |
| Dependencies | The template's, plus `patch-package` |

## Running it

React Native 0.87 links its core from prebuilt XCFrameworks by default
(`react_native_pods.rb` sets `RCT_USE_PREBUILT_RNCORE=1` unless you set it to
`0`). A patch to `RCTScrollViewComponentView.mm` under `node_modules` only takes
effect if React Native core is compiled from source, so **`pod install` needs
`RCT_USE_PREBUILT_RNCORE=0`**:

```bash
cd ReproducerApp
yarn install                     # postinstall applies patches/ with patch-package
(cd ios && bundle install && RCT_USE_PREBUILT_RNCORE=0 bundle exec pod install)
yarn start
yarn ios
```

`RCT_USE_RN_DEP` (the third-party dependencies: folly, glog and so on) can stay
prebuilt. The bugs themselves reproduce with the prebuilt core too; only the
**fix** switches need the source build. The readout shows `native patch not
active yet (or prebuilt core)` in red when the patched code isn't running. The
app writes a random token to `NSUserDefaults`, and the patched native code
echoes it back the first time it prepares an anchor.

That was checked by building the same app with the default `pod install`: the
prebuilt `React.framework` contains none of the patch's strings, the readout
shows the warning, there are no `[mvcp]` log lines, and **stock** and **fix**
both lose the position by the same -1049.0pt
([`evidence/ios-prebuilt-core.log`](evidence/ios-prebuilt-core.log)).

A source build also honours `RCT_METRO_PORT`. I ran Metro on port 8191 with
`yarn start --port 8191` and built with `RCT_METRO_PORT=8191`. The default port
needs neither.

## The switches

[`patches/react-native+0.87.1.patch`](ReproducerApp/patches/react-native+0.87.1.patch)
changes only `RCTScrollViewComponentView.mm`. It reads two modes from
`NSUserDefaults` on every mount, and the app sets them with `Settings.set()`,
so stock and fixed can be compared in one build. Every launch starts in stock
mode. The patch also logs each anchor decision as `[mvcp]` lines (see
[Logs](#logs)).

**Anchor**, which view `_prepareForMaintainVisibleScrollPosition` measures:

| Button | Behaviour |
| --- | --- |
| `stock` | 0.87.1 and `main`: the first subview whose end is past the offset (`origin + size > offset`) |
| `proto` | The simpler fix tried first: the first subview whose origin is at or past the offset (`origin >= offset`). This is the pre-#43203 rule, give or take the `=`. |
| `fix` | The proposed fix: stock's anchor, but if it straddles the leading edge and is gone, recycled or resized by the mount, measure the view after it instead (if that one starts inside the viewport) |

**Guard**, when `_adjustForMaintainVisibleContentPosition` refuses to correct:

| Button | Behaviour |
| --- | --- |
| `0.87.1` | 0.87.1: a tag check, but only behind `enableViewCulling()`, which is off |
| `main` | `main` and 0.88, from #57294: abort if the anchor is nil, if its tag changed, or if it is no longer a subview of the content view. Copied verbatim; it is the only mVCP difference between 0.87.1 and `main`. |
| `fix` | The proposed fix: `main` without the subview check |

With **Anchor** `stock` and **Guard** `0.87.1`, the code runs exactly as in
0.87.1, plus the logging.

## The screens

Each screen has a **Run** button that resets the list, sets the scene up,
changes the data once, and 2-3 s later measures how far a landmark row moved on
screen. The bottom line of the readout gives the verdict: green `held`, or red
`JUMPED` / `LOST`. Every row is labelled with its id and height. Heights are
deterministic, so runs repeat to the point.

### A: spacer

A `FlatList` with `maintainVisibleContentPosition={{ minIndexForVisible: 0 }}`
and a 120pt `ListHeaderComponent`, at the top, with 100 rows of 60-600pt. **Run**
prepends 20 rows of 60pt and watches row 0, highlighted in yellow.

1. VirtualizedList shifts its window down by 20. It renders the first 10 new
   rows as its retained head cells, and an interior spacer, estimated at
   10 × the average row height, stands in for the other 10. mVCP anchors on row
   0 and corrects by +3990.7. That part is right.
2. Row 0 is now at the offset plus the header's 120pt, and the spacer ends
   exactly where row 0 starts. So the spacer is "partially visible" by 120pt,
   and the next transaction picks it as the anchor.
3. Once the ten 60pt head cells are measured, the average row height drops, and
   VirtualizedList shrinks the spacer by 962.3pt. Its origin doesn't move, so
   mVCP corrects nothing, while row 0 and everything below it move up by
   962.3pt.

**ListHeaderComponent** off reproduces it too. The spacer then ends at the
offset to within a rounding error, and the strict `>` still picked it, by
0.000244pt (one float32 ulp at that offset;
[`evidence/ios-spacer-anchor-no-header.log`](evidence/ios-spacer-anchor-no-header.log)).
With the header the margin is a robust 120pt. Any content above the first row
does the same: a header, `contentContainerStyle` padding, or overscroll.

The list sets `maxToRenderPerBatch={30}`. Stock fails the same way without it.
But with the default of 10, once the native fix has held row 0, VirtualizedList
works out its next window from `avg * index` estimates for the unmeasured rows,
renders 10 cells that leave row 0 out, and unmounts it. See
[The fix needs a VirtualizedList fix too](#the-fix-needs-a-virtualizedlist-fix-too).

### B: unmounted

A plain `ScrollView` with mVCP, 60 rows, scrolled to y=2000. Row 5 straddles the
top edge, so it is the anchor. The landmark is row 6.

- **Prepend**: prepend 12 rows of 200pt (2400pt) in one update. With **Clip** on
  (`removeClippedSubviews`), row 5 moves 2400pt down, out of the clip rect, and
  `_remountChildren` detaches it just before the correction. That's the
  clipped-anchor bug.
- **Remove+prepend**: remove row 5 and prepend one 100pt row, in one update.
  Row 5's native view goes to the recycle pool and is handed straight back out
  for the new row at the top. See
  [Background](#background-the-unmounted-anchor-on-0871).

**Clip** is turned on just after each mount rather than at mount, which works
around a separate bug (see [Other findings](#other-findings)).

### C: control

The same plain ScrollView at y=2000. **Insert below** inserts three 150pt rows
directly below the straddling row 5, and watches row 5. This is the case #43203
chose "first partially visible" for: stock keeps row 5 where it is and shows the
new rows below it. It shows that the `proto` rule changes that behaviour and the
proposed `fix` doesn't.

## Results

From the logs in [`evidence/`](evidence). The `n/n` counts are runs of the final
patch. For the paths that didn't change between my builds (`stock`, `proto`,
`0.87.1` and `main`), they include earlier runs with the same screen layout.
Earlier builds with a different control layout agreed (A stock -919.3 in 5/5),
and so did an earlier revision of the fix.

**A: spacer** (row 0's movement):

| | stock | `fix` | `proto` |
| --- | --- | --- | --- |
| Header on | **-962.3** (3/3) | **+0.0** (3/3) | +0.0 (1/1) |
| Header off | **-910.7** (1/1) | **+0.0** (2/2) | |
| Header on, `maxToRenderPerBatch={10}` | **-962.3** (1/1) | **-1828.3** (2/2) | -1828.3 (1/1) |
| Header on, unmodified 0.88.0-rc.4 | **-1049.0** (1/1) | | |

The 0.88 figure is larger only because there the readout has an extra line (the
"patch not active" warning), so the list is shorter.

**C: control** (row 5's movement): stock **+0.0** (3/3), `proto` **-450.0**
(3/3), `fix` **+0.0** (2/2).

**B: Prepend 2400pt** (row 6's movement):

| | 0.87.1 | `main` | `fix` | unmodified 0.88.0-rc.4 |
| --- | --- | --- | --- | --- |
| Clip on | +0.0 (2/2) | **+2400.0** (2/2) | +0.0 (2/2) | **+2400.0** (3/3) |
| Clip off | +0.0 (1/1) | +0.0 (2/2) | | +0.0 (2/2) |

**B: Remove+prepend** (row 6's movement):

| Anchor / Guard | 0.87.1 | `main` | `fix` |
| --- | --- | --- | --- |
| stock | **+1713.0** (2/2) | -138.0 (2/2) | -138.0 (1/1) |
| `fix` | | +0.0 (2/2) | +0.0 (1/1) |

Unmodified 0.88.0-rc.4: -138.0 (1/1), the same as `main`. -138.0 is what
happens with no correction at all: +100 for the prepended row, -238 for the
removed one.

## Background: the unmounted anchor on 0.87.1

In 0.87.1, `_adjustForMaintainVisibleContentPosition` trusts the anchor
recorded before the mount, even if the mount unmounted it. Plain views *are*
recycled on iOS: `RCTViewComponentView` has no `+shouldBeRecycled`, so the
registry pools it, whatever `enableViewRecycling` says. An unmounted anchor
ends up in one of three states:

- pooled: tag 0, old frame. The delta is 0, and the mount's change goes
  uncorrected.
- handed out again in the same transaction: a new tag and someone else's frame.
  The delta is arbitrary. **Remove+prepend** gets row 5's view back as the new
  row at y=0, so it corrects by 0 - 1851 and the list teleports (row 6 +1713.0).
- deallocated: nil, so `CGRectZero`, and the list jumps by minus the old origin.

#57294 (in 0.88) catches all three, with a nil check and an unconditional tag
check. That fixes the teleport, and #52757 (closed) and #52782 (open) cover the
same ground, so this isn't drafted as an issue. What #57294 does is give up: in
**Remove+prepend** the prepend then goes uncorrected (-138.0). The proposed
anchor `fix` falls back to the view after a straddling anchor that was recycled,
so it holds there (+0.0). An earlier variant, which re-keyed the anchor row
instead of removing it, happened to come out right on 0.87.1, because the
recycled view came back as the replacement row in the same place. `main`
instead left that prepend uncorrected (+100.0).

## The fix needs a VirtualizedList fix too

With FlatList's default `maxToRenderPerBatch` (10), the native anchor fix
corrects the spacer transaction, and then the run still ends at -1828.3, worse
than stock's -962.3
([`evidence/ios-spacer-anchor-default-props.log`](evidence/ios-spacer-anchor-default-props.log)).
After the correction, VirtualizedList maps the new offset to row indices with
`getCellMetricsApprox`. For an unmeasured row that has measured rows after it,
that returns `avg * index`, which ignores the measured head cells above it. That
is the same root cause as
[#58870](https://github.com/react/react-native/issues/58870). So it renders a
fresh 10-cell window around index ~12 that leaves row 0 (index 20) out. Row 0
and the spacer are both unmounted and recycled in that transaction, so there is
nothing valid to measure, mVCP rightly aborts, and the shrink in that
transaction goes uncorrected. A batch of 30 keeps row 0 inside the window. A
real fix for FlatList needs both halves.

## Other findings

- **`removeClippedSubviews` is lost on recycled views.** `prepareForRecycle`
  resets `_removeClippedSubviews` to `NO`, but `updateProps:` diffs against the
  view's previous `_props`, which aren't reset. A recycled content view whose
  previous life also had `removeClippedSubviews` never turns clipping back on.
  I hit this in screen B: from the second mount on, every row stayed attached.
  It's the same on `main`, and it's not an mVCP bug, so it isn't drafted here.
- **Stale anchor when prepare records nothing.** If
  `_prepareForMaintainVisibleScrollPosition` finds no candidate (fewer subviews
  than `minIndexForVisible`, which `removeClippedSubviews` makes possible), the
  ivars still hold the previous transaction's anchor and frame, and the adjust
  step can apply that transaction's delta a second time. Clearing the ivars
  after each adjust prevents it. Not reproduced here.
- **Android.** By reading only, not tested here. `MaintainVisibleScrollPositionHelper.computeTargetView()`
  uses the same `end > scroll` rule, so the spacer-anchor bug probably applies
  there too. It has no subview check, so the clipped-anchor regression is
  iOS-only. Its anchor is a `WeakReference` that is only cleared by GC, so an
  unmounted anchor gives a delta of 0 rather than a teleport.

## Demo videos

Recorded with this app, in real time, with only the lead-in trimmed. Taps show
as circles. A verdict stays on screen until the next run starts, so a mode
button can change just before its result is replaced. The videos carry Argent's
watermark (the tool used to record them).

**[`evidence/ios-spacer-anchor.mp4`](evidence/ios-spacer-anchor.mp4)** (42 s):

| Time | What happens |
| --- | --- |
| 0:01 | Screen A, stock. **Run**. |
| 0:03 | 20 rows prepended. The view holds for a moment, then jumps: row 0 leaves the screen, and the verdict reads `row 0 moved -962.3pt: JUMPED`. |
| 0:08-0:09 | Anchor `fix`, **Run** again. |
| 0:11-0:14 | Same prepend. Row 0 stays where it was: `+0.0pt: held`. |
| 0:15-0:17 | Screen C, anchor `stock`, **Insert below**. Three rows appear below row 5, and row 5 stays put: held. |
| 0:22-0:23 | Anchor `proto`, **Insert below**. Row 5 is scrolled off the top: `-450.0pt`. |
| 0:28-0:29 | Anchor `fix`, **Insert below**. Back to stock behaviour: held. |

**[`evidence/ios-clipped-anchor.mp4`](evidence/ios-clipped-anchor.mp4)** (30 s),
screen B with **Clip** on:

| Time | What happens |
| --- | --- |
| 0:01 | Guard `0.87.1`, **Prepend**. 2400pt prepended and corrected: held. |
| 0:06-0:07 | Guard `main`, **Prepend**. The prepended rows push the content down: `+2400.0pt: JUMPED`. |
| 0:12 | Guard `fix`, **Prepend**: held. |
| 0:17-0:19 | Guard `main`, **Clip** off, **Prepend**: held. Without clipping, `main` is fine. |

**[`evidence/ios-clipped-anchor-0.88.0-rc.4.mp4`](evidence/ios-clipped-anchor-0.88.0-rc.4.mp4)**
(17 s), the same app on an unmodified 0.88.0-rc.4 (the mode buttons do nothing
there): **Prepend** with **Clip** on, `+2400.0pt: JUMPED`, then with **Clip**
off, held.

**[`evidence/ios-unmounted-anchor-0.87.1.mp4`](evidence/ios-unmounted-anchor-0.87.1.mp4)**
(25 s), screen B, **Remove+prepend**, **Clip** off: guard `0.87.1` teleports
(`+1713.0pt`, at 0:02), guard `main` doesn't correct (`-138.0pt`, at 0:08), and
guard `main` with anchor `fix` holds (at 0:13). This one was recorded before
the last revision of the anchor fix; the final patch gives the same result.

## Logs

[`evidence/`](evidence) has the native and JS logs for each recording, and for
the extra runs. The `[mvcp]` lines come from the patch: one `prepare` line per
transaction (the anchor chosen, its frame, and how far it straddles the top
edge, if it does) and one `adjust` line (the anchor's state, its old and new
`y`, and the correction or the reason for aborting). The `[repro]` lines come
from `App.tsx`: every scroll event and content-size change, with
VirtualizedList's render window (`vl=[first,last]`), and the verdicts.

| File | What |
| --- | --- |
| [`ios-spacer-anchor.log`](evidence/ios-spacer-anchor.log) | The spacer and control demo |
| [`ios-spacer-anchor-no-header.log`](evidence/ios-spacer-anchor-no-header.log) | Screen A without the header: the 0.000244pt straddle |
| [`ios-spacer-anchor-default-props.log`](evidence/ios-spacer-anchor-default-props.log) | Screen A with `maxToRenderPerBatch={10}` |
| [`ios-clipped-anchor.log`](evidence/ios-clipped-anchor.log) | The clipped-anchor demo |
| [`ios-unmounted-anchor-0.87.1.log`](evidence/ios-unmounted-anchor-0.87.1.log) | The Remove+prepend demo |
| [`ios-0.88.0-rc.4.log`](evidence/ios-0.88.0-rc.4.log) | Unmodified 0.88.0-rc.4: screens A and B (JS lines only) |
| [`ios-prebuilt-core.log`](evidence/ios-prebuilt-core.log) | The patched app on the prebuilt core: the patch has no effect |

`App.tsx` reads VirtualizedList's render window from private fields
(`_listRef.state.cellsAroundViewport`), for the logs only.
