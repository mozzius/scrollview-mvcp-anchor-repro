# iOS: `maintainVisibleContentPosition` anchors on a VirtualizedList spacer that straddles the top edge, so a spacer re-estimate after a prepend goes uncorrected

### Description

Rows prepended to a `FlatList` with `maintainVisibleContentPosition`, more than `initialNumToRender` of them, while it sits at the top. mVCP corrects the prepend. One transaction later, the visible content jumps by however much VirtualizedList re-estimated a spacer by, and nothing corrects it. In the repro the row the user was looking at moves 962pt up and off screen, every time.

#### Cause

`_prepareForMaintainVisibleScrollPosition` anchors on the first subview whose end is past the offset ([L1079](https://github.com/react/react-native/blob/bf62cce504e/packages/react-native/React/Fabric/Mounting/ComponentViews/ScrollView/RCTScrollViewComponentView.mm#L1079)). `_adjustForMaintainVisibleContentPosition` then corrects by how far that view's **origin** moved. For a view that straddles the top edge and is resized, the origin stays put while everything after it moves.

After a prepend at the top, a VirtualizedList spacer straddles the top edge as a matter of course. It's the interior spacer between the retained head cells (`[0, initialNumToRender)`) and the window. Then:

1. The prepend is corrected (+3990.7pt). The spacer now ends where the old first row starts, below the offset, so it becomes the anchor.
2. VirtualizedList measures the head cells, its average row height drops, and it shrinks the spacer by 962.3pt. The spacer's origin doesn't move, so `deltaY` is 0, and everything below it moves up 962.3pt.

```text
[mvcp] prepare anchorMode=0 offset=3990.7 contentH=10552.7 anchor=subviews[11/32] tag=846 y=720.0 h=3390.7 (straddles the top edge: bottom - offset = 120)
[mvcp] adjust guardMode=0 offset=3990.7 contentH=9590.3 anchor=alive tag=846/846 attached=YES prevY=720.0 newY=720.0
[repro] verdict: row 0 at screen y=-564.0, moved -962.3
```

It happens without a list header too. Then the spacer ends at the offset plus one float32 ulp, and the strict `>` still picks it (-910.7pt).

#### Fix

Going back to "first fully visible" (`origin >= offset`) fixes this case, but it reverts #43203. In the repro's control screen, where rows are inserted below a straddling row, it scrolls that row 450pt off the top.

Instead, keep #43203's anchor. If it straddles the leading edge, also record the next view, provided that one starts inside the viewport (with half a point of slack). If the mount resized, recycled or removed the straddling anchor, measure that next view instead. With the fix, the repro holds (+0.0, 3/3 with a header, 2/2 without) and the control holds (+0.0).

<details>
<summary>Diff against <code>main</code></summary>

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
</details>

This is enough for a `ScrollView`, but `FlatList` also needs a VirtualizedList fix. With the default `maxToRenderPerBatch`, once the anchor is held, VirtualizedList maps the corrected offset through `avg * index` estimates (the same root cause as #58870), renders a window without the anchor and unmounts it (-1828.3pt). The repro sets `maxToRenderPerBatch={30}` to isolate the native part.

Related: #43203, #55545 (open, handles growth only), #57959, #58870. Android's `computeTargetView()` uses the same `end > scroll` rule. I haven't tested Android yet.

### Steps to reproduce

1. `git clone https://github.com/mozzius/scrollview-mvcp-anchor-repro && cd scrollview-mvcp-anchor-repro/ReproducerApp && yarn install`
2. `cd ios && bundle install && RCT_USE_PREBUILT_RNCORE=0 bundle exec pod install && cd ..` (core built from source so the repro's switches compile in; the bug also reproduces on the prebuilt core)
3. `yarn start`, then `yarn ios`
4. On **A: spacer**, with **Anchor** `stock`, tap **Run**. It prepends 20 rows at the top and reports `row 0 moved -962.3pt: JUMPED`.
5. Set **Anchor** to `fix` and tap **Run**. It reports `+0.0pt: held`.
6. Optional: on **C: control**, tap **Insert below** with `stock`, `proto` and `fix`. You get +0.0, -450.0 and +0.0.

### React Native Version

0.87.1, an unmodified 0.88.0-rc.4, and `main`.

### Affected Platforms

Runtime - iOS

### Output of `npx @react-native-community/cli info`

```text
System:
  OS: macOS 27.0.1
IDEs:
  Xcode: 27.0/27A266a
npmPackages:
  react: 19.2.3
  react-native: 0.87.1
iOS:
  hermesEnabled: true
  newArchEnabled: true
```

Tested on the iOS Simulator (iPhone 17 Pro, iOS 26.5).

### Stacktrace or Logs

See above. The full logs are in the repro's [`evidence/`](https://github.com/mozzius/scrollview-mvcp-anchor-repro/tree/main/evidence).

### MANDATORY Reproducer

https://github.com/mozzius/scrollview-mvcp-anchor-repro

### Screenshots and Videos

- [`ios-spacer-anchor.mp4`](https://github.com/mozzius/scrollview-mvcp-anchor-repro/blob/main/evidence/ios-spacer-anchor.mp4): screen A stock (jumps -962.3pt), then fixed (held), then screen C with stock, `origin >= offset` and the fix.
