# iOS: `maintainVisibleContentPosition` anchors on a VirtualizedList spacer that straddles the top edge, so a spacer re-estimate after a prepend goes uncorrected

<!--
Draft for react/react-native, bug report template.
Template fields are the "###" headings below. Attach evidence/ios-spacer-anchor.mp4 when filing.
-->

### Description

A `FlatList` with `maintainVisibleContentPosition` sits at the top of the list, and more rows are prepended than `initialNumToRender`. mVCP corrects for the prepend correctly. Then, one transaction later, the content jumps up by the amount VirtualizedList re-estimated a spacer by, and nothing corrects it. In the repro the row the user was looking at moves 962pt up, off the screen. It is deterministic.

It happens because mVCP picks a VirtualizedList spacer as its anchor, and a spacer's origin doesn't move when it is resized.

#### Root cause

`_prepareForMaintainVisibleScrollPosition` anchors on the first content subview whose end is past the offset ([L1079](https://github.com/react/react-native/blob/73f420430c08a9d8724ad569623600d0f58f1688/packages/react-native/React/Fabric/Mounting/ComponentViews/ScrollView/RCTScrollViewComponentView.mm#L1079)):

```objc
hasNewView = subview.frame.origin.y + subview.frame.size.height > _scrollView.contentOffset.y;
```

`_adjustForMaintainVisibleContentPosition` then moves the offset by how far that view's **origin** moved. That doesn't work for a view that straddles the top edge and changes size in the transaction: its origin stays put while everything after it moves. A VirtualizedList spacer, which stands in for unmounted rows with an estimated height, is exactly such a view, and VirtualizedList re-estimates it whenever its average row height changes.

After a prepend at the top, the spacer straddles the top edge as a matter of course. Step by step, from the repro's log (`FlatList`, 120pt `ListHeaderComponent`, 100 rows of 60-600pt, 20 rows of 60pt prepended at offset 0):

1. VirtualizedList shifts its window. It renders the first 10 new rows as its retained head cells (`[0, initialNumToRender)`), and an interior spacer estimated at 10 × the average row height stands in for the other 10. mVCP anchors on the old first row and corrects by +3990.7. That's right.
2. The old first row now starts at `offset + 120`, the header's height, and the spacer ends exactly where that row starts. So the spacer's end is 120pt past the offset, and the next transaction picks it as the anchor.
3. VirtualizedList measures the ten 60pt head cells, its average row height drops, and it shrinks the spacer by 962.3pt. The spacer's origin doesn't move, so `deltaY` is 0. The old first row, and everything the user is looking at, moves up by 962.3pt.

```text
[mvcp] adjust guardMode=0 offset=0.0 contentH=10552.7 anchor=alive tag=442/442 attached=YES prevY=120.0 newY=4110.7
[mvcp] adjust corrected deltaY=+3990.7 offset 0.0 -> 3990.7
[mvcp] prepare anchorMode=0 offset=3990.7 contentH=10552.7 anchor=subviews[11/32] tag=846 y=720.0 h=3390.7 (straddles the top edge: bottom - offset = 120)
[mvcp] adjust guardMode=0 offset=3990.7 contentH=9590.3 anchor=alive tag=846/846 attached=YES prevY=720.0 newY=720.0
[repro] contentSize h=9590.3 vl=[20,38]
...
[repro] verdict: row 0 at screen y=-564.0, moved -962.3
```

The `[mvcp]` lines are logging the repro adds to `RCTScrollViewComponentView.mm`. `subviews[11]` is the spacer: subview 0 is the header and 1-10 are the head cells. In the second `adjust`, the content shrinks by 962.4pt and the anchor's `y` doesn't change.

The header isn't required. Without it the spacer ends at the offset to within rounding, and in the repro the strict `>` still picked it, because its end was 0.000244pt past the offset (one float32 ulp at ~4000pt). The jump was -910.7pt. Anything above the first row makes the margin robust: a list header, `contentContainerStyle` padding, or overscroll at the top.

#### Why not just go back to "first fully visible"?

Anchoring on the first view whose **origin** is at or past the offset (`origin >= offset`) fixes this case. I tried that first. But that is essentially the rule [#43203](https://github.com/react/react-native/pull/43203) moved away from, deliberately, to match CSS scroll anchoring and to stop a loading indicator being picked as the anchor. The repro has a control screen for that behaviour: rows inserted directly below a row the top edge cuts through. Stock keeps that row in place (+0.0). `origin >= offset` scrolls it 450pt off the top, because it anchors on the row after it, which the insertion moves.

#### Proposed fix

Keep #43203's anchor, but don't trust its origin when it can't be trusted. If the anchor straddles the leading edge, `_prepareForMaintainVisibleScrollPosition` also records the view after it, provided that view starts inside the viewport. If the mount then resized, unmounted or recycled the straddling anchor, `_adjustForMaintainVisibleContentPosition` measures that next view instead.

- A spacer re-estimate: the spacer changes size, so the next row is measured, and it moved by exactly the re-estimate. Fixed.
- A prepend above a straddling anchor: the anchor moves but keeps its size, so it is measured as now.
- An insertion below a straddling anchor (#43203's case): the anchor neither moves nor changes size, so nothing changes. The control screen holds at +0.0.
- A straddling anchor that grows or shrinks (an image loading, a streaming message): the visible content below it now stays put. That is what open PR #55545 is after, though #55545 only handles growth.
- A single view that covers the whole viewport: nothing starts inside the viewport, so there is no fallback. Unchanged.

Against `main` (73f4204):

```diff
diff --git a/packages/react-native/React/Fabric/Mounting/ComponentViews/ScrollView/RCTScrollViewComponentView.mm b/packages/react-native/React/Fabric/Mounting/ComponentViews/ScrollView/RCTScrollViewComponentView.mm
index ffd10bc6f2..cc9ef0d94b 100644
--- a/packages/react-native/React/Fabric/Mounting/ComponentViews/ScrollView/RCTScrollViewComponentView.mm
+++ b/packages/react-native/React/Fabric/Mounting/ComponentViews/ScrollView/RCTScrollViewComponentView.mm
@@ -112,6 +112,11 @@ @implementation RCTScrollViewComponentView {
   CGRect _prevFirstVisibleFrame;
   __weak UIView *_firstVisibleView;
   NSInteger _firstVisibleViewTag;
+  // The view after _firstVisibleView, recorded only when _firstVisibleView straddles the leading
+  // edge of the viewport and this one starts inside it.
+  CGRect _prevNextVisibleFrame;
+  __weak UIView *_nextVisibleView;
+  NSInteger _nextVisibleViewTag;
 
   CGFloat _endDraggingSensitivityMultiplier;
 
@@ -713,6 +718,9 @@ - (void)prepareForRecycle
   _prevFirstVisibleFrame = CGRectZero;
   _firstVisibleView = nil;
   _firstVisibleViewTag = 0;
+  _prevNextVisibleFrame = CGRectZero;
+  _nextVisibleView = nil;
+  _nextVisibleViewTag = 0;
   _virtualViewContainerState = nil;
 }
 
@@ -1069,6 +1077,9 @@ - (void)_prepareForMaintainVisibleScrollPosition
 
   BOOL horizontal = _scrollView.contentSize.width > self.frame.size.width;
   int minIdx = props.maintainVisibleContentPosition.value().minIndexForVisible;
+  _prevNextVisibleFrame = CGRectZero;
+  _nextVisibleView = nil;
+  _nextVisibleViewTag = 0;
   for (NSUInteger ii = minIdx; ii < _contentView.subviews.count; ++ii) {
     // Find the first view that is partially or fully visible.
     UIView *subview = _contentView.subviews[ii];
@@ -1082,6 +1093,22 @@ - (void)_prepareForMaintainVisibleScrollPosition
       _prevFirstVisibleFrame = subview.frame;
       _firstVisibleView = subview;
       _firstVisibleViewTag = subview.tag;
+      // If the anchor straddles the leading edge, also record the view after it, as long as that
+      // one starts inside the viewport. See _adjustForMaintainVisibleContentPosition.
+      if (ii + 1 < _contentView.subviews.count) {
+        UIView *nextView = _contentView.subviews[ii + 1];
+        CGFloat offset = horizontal ? _scrollView.contentOffset.x : _scrollView.contentOffset.y;
+        CGFloat length = horizontal ? _scrollView.bounds.size.width : _scrollView.bounds.size.height;
+        CGFloat start = horizontal ? CGRectGetMinX(subview.frame) : CGRectGetMinY(subview.frame);
+        CGFloat nextStart = horizontal ? CGRectGetMinX(nextView.frame) : CGRectGetMinY(nextView.frame);
+        // Half a point of slack, as for the delta below: after a correction, the next view's origin
+        // and the offset can differ by a rounding error in either direction.
+        if (start < offset && nextStart > offset - 0.5 && nextStart < offset + length) {
+          _prevNextVisibleFrame = nextView.frame;
+          _nextVisibleView = nextView;
+          _nextVisibleViewTag = nextView.tag;
+        }
+      }
       break;
     }
   }
@@ -1094,8 +1121,27 @@ - (void)_adjustForMaintainVisibleContentPosition
     return;
   }
 
+  UIView *firstVisibleView = _firstVisibleView;
+  NSInteger firstVisibleViewTag = _firstVisibleViewTag;
+  CGRect prevFirstVisibleFrame = _prevFirstVisibleFrame;
+
+  // The anchor is the first view that is partially or fully visible. If it straddles the leading
+  // edge and changed size in this transaction, its origin cannot say how far the content after it
+  // moved: a VirtualizedList spacer standing in for unmounted cells keeps its origin when it is
+  // re-estimated, while every cell after it moves. The same goes for a straddling anchor that was
+  // unmounted or recycled. In those cases measure the view after it instead. An anchor that only
+  // moved, or did not change at all, is still measured itself.
+  UIView *nextVisibleView = _nextVisibleView;
+  if (nextVisibleView != nil && nextVisibleView.tag == _nextVisibleViewTag &&
+      (firstVisibleView == nil || firstVisibleView.tag != firstVisibleViewTag ||
+       !CGSizeEqualToSize(firstVisibleView.frame.size, prevFirstVisibleFrame.size))) {
+    firstVisibleView = nextVisibleView;
+    firstVisibleViewTag = _nextVisibleViewTag;
+    prevFirstVisibleFrame = _prevNextVisibleFrame;
+  }
+
   // Abort if no first visible view (e.g., list was empty during mount)
-  if (!_firstVisibleView) {
+  if (!firstVisibleView) {
     return;
   }
 
@@ -1107,13 +1153,13 @@ - (void)_adjustForMaintainVisibleContentPosition
   // position, so the view at position 0 may have a different tag than before.
   // If the tag changed, we bail out to avoid applying the MVCP delta to the
   // wrong view, which would produce incorrect scroll offsets.
-  if (_firstVisibleView.tag != _firstVisibleViewTag) {
+  if (firstVisibleView.tag != firstVisibleViewTag) {
     return;
   }
 
   // Abort if the first visible view was deleted during mount (not recycled)
   // This prevents MVCP from applying a delta after scrollToOffset(0) during reset/clear
-  if (_firstVisibleView.superview != _contentView) {
+  if (firstVisibleView.superview != _contentView) {
     return;
   }
 
@@ -1121,7 +1167,7 @@ - (void)_adjustForMaintainVisibleContentPosition
   BOOL horizontal = _scrollView.contentSize.width > self.frame.size.width;
   // TODO: detect and handle/ignore re-ordering
   if (horizontal) {
-    CGFloat deltaX = _firstVisibleView.frame.origin.x - _prevFirstVisibleFrame.origin.x;
+    CGFloat deltaX = firstVisibleView.frame.origin.x - prevFirstVisibleFrame.origin.x;
     if (ABS(deltaX) > 0.5) {
       CGFloat x = _scrollView.contentOffset.x;
       [self _forceDispatchNextScrollEvent];
@@ -1134,8 +1180,8 @@ - (void)_adjustForMaintainVisibleContentPosition
       }
     }
   } else {
-    CGRect newFrame = _firstVisibleView.frame;
-    CGFloat deltaY = newFrame.origin.y - _prevFirstVisibleFrame.origin.y;
+    CGRect newFrame = firstVisibleView.frame;
+    CGFloat deltaY = newFrame.origin.y - prevFirstVisibleFrame.origin.y;
     if (ABS(deltaY) > 0.5) {
       CGFloat y = _scrollView.contentOffset.y;
       [self _forceDispatchNextScrollEvent];
```

There is half a point of slack in the "starts inside the viewport" test, as for the delta: right after a correction, the next view's origin and the offset can differ by a rounding error in either direction. Without the slack, the header-less case above still failed.

The repro runs this exact logic as a runtime switch in a patch to 0.87.1 (whose mVCP code differs from `main` only by #57294's guard). The patched `main` file passes `clang -fsyntax-only` with 0.87.1's headers, apart from an unrelated `main`-only `ScrollEvent` field. With the fix, the same steps hold the old first row exactly (+0.0, 3/3 with the header and 2/2 without). The control screen holds (+0.0, 2/2). The log shows the fallback in use:

```text
[mvcp] prepare anchorMode=2 offset=3990.7 contentH=10552.7 anchor=subviews[11/32] tag=1490 y=720.0 h=3390.7 (straddles the top edge: bottom - offset = 120) fallback=subviews[12] tag=1086 y=4110.7
[mvcp] adjust: straddling anchor alive tag=1490/1490 h 3390.7 -> 2428.3, measuring fallback tag=1086 instead
[mvcp] adjust corrected deltaY=-962.3 offset 3990.7 -> 3028.3
```

#### VirtualizedList needs a fix as well

The repro's list sets `maxToRenderPerBatch={30}`. Stock fails identically without it. But with the default of 10, once the native fix has held the anchor, VirtualizedList maps the corrected offset through `getCellMetricsApprox`. For the unmeasured rows that returns `avg * index`, ignoring the measured head cells above them (the same root cause as #58870). So VirtualizedList renders a 10-cell window that leaves the anchor out, and unmounts it. The anchor and its fallback are both recycled in that transaction, there is nothing left to measure, and the shrink in it goes uncorrected: -1828.3pt, 2/2. So `FlatList` needs this native fix plus a VirtualizedList fix that keeps its window consistent with what it has measured.

#### Related

- #43203: the switch to "first partially visible".
- #55545 (open PR): compensates growth of a first visible view whose origin didn't move. It doesn't cover shrinkage, which is this case.
- #57959 (open PR): anchor selection when `zIndex` reorders children.
- #58870: VirtualizedList's interior spacer sizing. The same spacer, a different bug.
- Android's `MaintainVisibleScrollPositionHelper.computeTargetView()` uses the same `end > scroll` rule, so it probably has the same problem. Not tested.

#### Expected

When a mount re-sizes a view that straddles the top edge, the content after it stays where it was on screen.

#### Actual

A spacer re-estimate after a prepend moves all the visible content by the re-estimate (-962.3pt here), with no correction.

### Steps to reproduce

1. `git clone https://github.com/mozzius/scrollview-mvcp-anchor-repro && cd scrollview-mvcp-anchor-repro/ReproducerApp`
2. `yarn install` (the `postinstall` applies the repro's patch, which only adds runtime switches and logging; in stock mode the code is unchanged)
3. `cd ios && bundle install && RCT_USE_PREBUILT_RNCORE=0 bundle exec pod install && cd ..` (React Native core must be built from source for the patch to compile in; the bug itself also reproduces with the default prebuilt core)
4. `yarn start`, then `yarn ios`
5. On screen **A: spacer**, with **Anchor** `stock`, tap **Run**. It resets the list at the top, waits 2.5s, prepends 20 rows of 60pt, and 3s later reports how far row 0 (yellow) moved: `row 0 moved -962.3pt: JUMPED`.
6. Set **Anchor** to `fix` and tap **Run** again: `+0.0pt: held`.
7. Optional: on **C: control**, tap **Insert below** with **Anchor** `stock`, `proto` and `fix`. You get +0.0, -450.0 and +0.0.

### React Native Version

0.87.1. Also reproduced on an unmodified 0.88.0-rc.4 build. The code is unchanged on `main` (73f4204).

### Affected Platforms

Runtime - iOS

### Output of `npx @react-native-community/cli info`

```text
System:
  OS: macOS 27.0.1
  CPU: (14) arm64 Apple M4 Pro
  Memory: 247.27 MB / 48.00 GB
  Shell:
    version: 5.3.20
    path: /opt/homebrew/bin/bash
Binaries:
  Node:
    version: 24.19.0
    path: ~/.nvm/versions/node/v24.19.0/bin/node
  Yarn:
    version: 1.22.22
    path: ~/.nvm/versions/node/v24.19.0/bin/yarn
  npm:
    version: 11.17.0
    path: ~/.nvm/versions/node/v24.19.0/bin/npm
  Watchman:
    version: 2026.09.21.00
    path: /opt/homebrew/bin/watchman
Managers:
  CocoaPods:
    version: 1.17.0
    path: ~/.rbenv/shims/pod
SDKs:
  iOS SDK:
    Platforms:
      - DriverKit 27.0
      - iOS 27.0
      - macOS 27.0
      - tvOS 27.0
      - visionOS 27.0
      - watchOS 27.0
  Android SDK:
    API Levels:
      - "29"
      - "33"
      - "34"
      - "35"
      - "36"
      - "37"
    Build Tools:
      - 30.0.3
      - 34.0.0
      - 35.0.0
      - 35.0.1
      - 36.0.0
      - 37.0.0
    System Images:
      - android-28 | Google ARM64-V8a Play ARM 64 v8a
      - android-29 | Google Play ARM 64 v8a
      - android-30 | Google APIs ARM 64 v8a
      - android-34 | Google Play ARM 64 v8a
      - android-35 | Google Play ARM 64 v8a
      - android-35 | Google Play Tablet ARM 64 v8a
      - android-36 | Google Play ARM 64 v8a
    Android NDK: Not Found
IDEs:
  Android Studio: 2026.1 AI-261.26222.65.2614.16379836
  Xcode:
    version: 27.0/27A266a
    path: /usr/bin/xcodebuild
Languages:
  Java:
    version: 17.0.20.1
    path: /usr/bin/javac
  Ruby:
    version: 2.7.6
    path: ~/.rbenv/shims/ruby
npmPackages:
  "@react-native-community/cli":
    installed: 20.2.0
    wanted: 20.2.0
  react:
    installed: 19.2.3
    wanted: 19.2.3
  react-native:
    installed: 0.87.1
    wanted: 0.87.1
  react-native-macos: Not Found
npmGlobalPackages:
  "*react-native*": Not Found
Android:
  hermesEnabled: true
  newArchEnabled: true
iOS:
  hermesEnabled: true
  newArchEnabled: true
```

Tested on: iOS Simulator (iPhone 17 Pro, iOS 26.5), New Architecture.

### Stacktrace or Logs

See the excerpts above. The full logs, including the header-less run and the default-`maxToRenderPerBatch` runs, are in the repro's [`evidence/`](https://github.com/mozzius/scrollview-mvcp-anchor-repro/tree/main/evidence).

### MANDATORY Reproducer

https://github.com/mozzius/scrollview-mvcp-anchor-repro

### Screenshots and Videos

<!-- Drag this into the issue when filing; GitHub hosts the upload. -->

- `evidence/ios-spacer-anchor.mp4` (iOS simulator, 42s). Screen A, stock: after the prepend the view holds for a moment, then row 0 jumps off the top (-962.3pt). With the fix: held. Then screen C: stock keeps the straddling row in place, `origin >= offset` scrolls it 450pt away, and the fix keeps it in place.
