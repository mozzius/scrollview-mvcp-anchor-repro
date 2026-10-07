# [0.88 regression] iOS: `maintainVisibleContentPosition` skips the correction when `removeClippedSubviews` has detached the anchor

<!--
Draft for react/react-native, bug report template.
Template fields are the "###" headings below. Attach evidence/ios-clipped-anchor-0.88.0-rc.4.mp4 and evidence/ios-clipped-anchor.mp4 when filing.
-->

### Description

On 0.88 (from 0.88.0-rc.0, via #57294), a `ScrollView` or `FlatList` with both `maintainVisibleContentPosition` and `removeClippedSubviews` no longer corrects for a prepend taller than about a screen. The prepended content pushes everything the user was looking at down by its full height. On 0.87.1 the same prepend is held exactly.

In the repro (a plain `ScrollView`, scrolled to y=2000, 12 rows of 200pt prepended in one update):

| | `removeClippedSubviews` on | off |
| --- | --- | --- |
| 0.87.1 | held, +0.0 (2/2) | held, +0.0 (1/1) |
| 0.88.0-rc.4, unmodified | **+2400.0** (3/3) | held, +0.0 (2/2) |
| 0.87.1 with `main`'s mVCP guard copied in | **+2400.0** (2/2) | held, +0.0 (2/2) |
| 0.87.1 with `main`'s guard minus the check below | held, +0.0 (2/2) | |

#### Root cause

#57294 added three early returns to `_adjustForMaintainVisibleContentPosition`. The third is ([L1114-L1118](https://github.com/react/react-native/blob/73f420430c08a9d8724ad569623600d0f58f1688/packages/react-native/React/Fabric/Mounting/ComponentViews/ScrollView/RCTScrollViewComponentView.mm#L1114-L1118)):

```objc
// Abort if the first visible view was deleted during mount (not recycled)
// This prevents MVCP from applying a delta after scrollToOffset(0) during reset/clear
if (_firstVisibleView.superview != _contentView) {
  return;
}
```

`-mountingTransactionDidMount` runs `-_remountChildren` **before** `-_adjustForMaintainVisibleContentPosition` ([L292-L297](https://github.com/react/react-native/blob/73f420430c08a9d8724ad569623600d0f58f1688/packages/react-native/React/Fabric/Mounting/ComponentViews/ScrollView/RCTScrollViewComponentView.mm#L292-L297)). With `removeClippedSubviews`, `-_remountChildren` clips the content view against the scroll view's bounds ± 44pt, still at the old offset, and `-[RCTViewComponentView updateClippedSubviewsWithClipRect:relativeToView:]` calls `removeFromSuperview` on every child outside that rect ([L320-L330](https://github.com/react/react-native/blob/73f420430c08a9d8724ad569623600d0f58f1688/packages/react-native/React/Fabric/Mounting/ComponentViews/View/RCTViewComponentView.mm#L320-L330)). A prepend moves the anchor down by the prepended height. Once that is more than about a screen, the anchor is outside the clip rect and is detached right before the check, so the check returns and nothing is corrected.

The detached anchor is still a perfectly good anchor. The content view keeps it in `_reactSubviews`, and Fabric has already applied this transaction's layout to it, so its frame is the new frame, in the content view's coordinate space. 0.87.1 reads that frame and corrects exactly. The correction's own `contentOffset` write then runs `-scrollViewDidScroll:`, whose `-_remountChildrenIfNeeded` remounts the anchor at its corrected position. From the repro's log, stock 0.87.1, then `main`'s guard:

```text
[mvcp] prepare anchorMode=0 offset=2000.0 contentH=20373.0 anchor=subviews[0/3] tag=6320 y=1851.0 h=238.0 (straddles the top edge: bottom - offset = 89)
[mvcp] adjust guardMode=0 offset=2000.0 contentH=22773.0 anchor=alive tag=6320/6320 attached=NO prevY=1851.0 newY=4251.0
[mvcp] adjust corrected deltaY=+2400.0 offset 2000.0 -> 4400.0

[mvcp] prepare anchorMode=0 offset=2000.0 contentH=20373.0 anchor=subviews[0/3] tag=7212 y=1851.0 h=238.0 (straddles the top edge: bottom - offset = 89)
[mvcp] adjust guardMode=1 offset=2000.0 contentH=22773.0 anchor=alive tag=7212/7212 attached=NO prevY=1851.0 newY=4251.0
[mvcp] adjust bail: anchor not a subview of the content view (main)
```

(`[mvcp]` lines are logging the repro adds. `attached` is `superview == _contentView`.)

#### The check isn't needed for what it was added for

A view that is really deleted in the mount goes through `-[RCTComponentViewRegistry enqueueComponentViewWithComponentHandle:tag:componentViewDescriptor:]`, which sets `view.tag = 0` whether or not the view is then recycled ([L67-L68](https://github.com/react/react-native/blob/73f420430c08a9d8724ad569623600d0f58f1688/packages/react-native/React/Fabric/Mounting/RCTComponentViewRegistry.mm#L67-L68)). If it is handed out again in the same transaction, it gets the new element's tag. Either way, #57294's tag check, just above this one, already returns. A deleted view that was deallocated is caught by the nil check. So the superview check only adds one case, the clipped but still mounted anchor, and that is the case where the correction is valid. In the repro, removing the anchor row in the same update as a prepend still returns at the tag check with the check removed (`bail: tag changed`). #57294's reset/clear scenario is the same deletion path.

#### Proposed fix

Remove the check. Against `main` (73f4204):

```diff
diff --git a/packages/react-native/React/Fabric/Mounting/ComponentViews/ScrollView/RCTScrollViewComponentView.mm b/packages/react-native/React/Fabric/Mounting/ComponentViews/ScrollView/RCTScrollViewComponentView.mm
index ffd10bc6f2..3e9b203e11 100644
--- a/packages/react-native/React/Fabric/Mounting/ComponentViews/ScrollView/RCTScrollViewComponentView.mm
+++ b/packages/react-native/React/Fabric/Mounting/ComponentViews/ScrollView/RCTScrollViewComponentView.mm
@@ -1111,11 +1111,13 @@ - (void)_adjustForMaintainVisibleContentPosition
     return;
   }
 
-  // Abort if the first visible view was deleted during mount (not recycled)
-  // This prevents MVCP from applying a delta after scrollToOffset(0) during reset/clear
-  if (_firstVisibleView.superview != _contentView) {
-    return;
-  }
+  // Deliberately not checked: whether the anchor is still a subview of _contentView.
+  // -mountingTransactionDidMount runs -_remountChildren first, and with removeClippedSubviews a
+  // prepend that moves the anchor out of the clip rect detaches it there. It is still retained (in
+  // the content view's _reactSubviews), and it already has this transaction's frame, so the delta
+  // is still right. A view that was really deleted is caught by the tag check above:
+  // -[RCTComponentViewRegistry enqueueComponentViewWithComponentHandle:...] resets its tag to 0
+  // whether or not it is recycled.
 
   std::optional<int> autoscrollThreshold = props.maintainVisibleContentPosition.value().autoscrollToTopThreshold;
   BOOL horizontal = _scrollView.contentSize.width > self.frame.size.width;
```

The repro runs `main`'s guard and this one as runtime switches in a patch to 0.87.1 (`main`'s mVCP code differs from 0.87.1 only by #57294). The results are in the table above. I also checked that an unmodified 0.88.0-rc.4 behaves like the copied guard.

#### Who hits it

Any `ScrollView` with both props, and any `FlatList` that opts into `removeClippedSubviews` on iOS (it is opt-in there, unless `shouldUseRemoveClippedSubviewsAsDefaultOnIOS` is turned on), whenever more than about a screen of content is inserted above the anchor in one update. That covers loading older messages into a chat list, newer posts into a feed, or restoring a scroll position into a prepended page.

Android's `MaintainVisibleScrollPositionHelper` has no equivalent check, so it isn't affected.

#### Expected

A prepend above the visible content is held whether or not `removeClippedSubviews` is set, as on 0.87.1.

#### Actual

With `removeClippedSubviews`, any prepend taller than about a screen goes uncorrected, and the visible content is pushed down by the prepend's full height.

### Steps to reproduce

1. `git clone https://github.com/mozzius/scrollview-mvcp-anchor-repro && cd scrollview-mvcp-anchor-repro/ReproducerApp`
2. `yarn install` (the `postinstall` applies the repro's patch: runtime switches and logging only)
3. `cd ios && bundle install && RCT_USE_PREBUILT_RNCORE=0 bundle exec pod install && cd ..` (React Native core must be built from source for the patch to compile in)
4. `yarn start`, then `yarn ios`
5. Open **B: unmounted**, turn **Clip** on (`removeClippedSubviews`), and set **Guard** to `main`. Tap **Prepend**. It scrolls to y=2000, prepends 12 rows of 200pt, and reports how far row 6 moved: `+2400.0pt: JUMPED`.
6. Set **Guard** to `0.87.1` or `fix` and tap **Prepend** again: `+0.0pt: held`. With **Clip** off, `main` holds too.

To see it without any patch: run the repro's `App.tsx` in a 0.88.0-rc.4 app (the mode buttons do nothing there), and repeat step 5.

### React Native Version

0.88.0-rc.4, and `main` (73f4204). Not in 0.87.1.

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

That is the 0.87.1 repro app. The 0.88 check used the same machine with `react-native@0.88.0-rc.4` and `react@19.3.0`, from the 0.88.0-rc.4 community template. Tested on: iOS Simulator (iPhone 17 Pro, iOS 26.5), New Architecture.

### Stacktrace or Logs

See above. The full logs, including the unmodified 0.88.0-rc.4 runs, are in the repro's [`evidence/`](https://github.com/mozzius/scrollview-mvcp-anchor-repro/tree/main/evidence).

### MANDATORY Reproducer

https://github.com/mozzius/scrollview-mvcp-anchor-repro

### Screenshots and Videos

<!-- Drag these into the issue when filing; GitHub hosts the uploads. -->

- `evidence/ios-clipped-anchor-0.88.0-rc.4.mp4` (unmodified 0.88.0-rc.4, 17s): **Prepend** with `removeClippedSubviews` pushes the content down by 2400pt. Without it, held.
- `evidence/ios-clipped-anchor.mp4` (the 0.87.1 repro, 30s): the same prepend with `removeClippedSubviews`, held by 0.87.1's guard, pushed down 2400pt by `main`'s, and held by the fix. Then `main` without `removeClippedSubviews`: held.
