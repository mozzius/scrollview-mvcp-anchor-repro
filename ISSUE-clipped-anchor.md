# [0.88 regression] iOS: `maintainVisibleContentPosition` skips the correction when `removeClippedSubviews` has detached the anchor

### Description

Since #57294 (0.88.0-rc.0), a `ScrollView` or `FlatList` with both `maintainVisibleContentPosition` and `removeClippedSubviews` no longer corrects for a prepend taller than about a screen. The visible content is pushed down by the prepend's full height. 0.87.1 holds it.

In the repro, a `ScrollView` at y=2000 gets 12 rows of 200pt prepended:

| | `removeClippedSubviews` on | off |
| --- | --- | --- |
| 0.87.1 | held (2/2) | held |
| 0.88.0-rc.4, unmodified | **pushed down 2400pt** (3/3) | held |
| 0.87.1 with `main`'s guard | **pushed down 2400pt** (2/2) | held |
| 0.87.1 with `main`'s guard minus the check below | held (2/2) | |

#### Cause

#57294 added this check to `_adjustForMaintainVisibleContentPosition` ([L1114-L1118](https://github.com/react/react-native/blob/bf62cce504e/packages/react-native/React/Fabric/Mounting/ComponentViews/ScrollView/RCTScrollViewComponentView.mm#L1114-L1118)):

```objc
if (_firstVisibleView.superview != _contentView) {
  return;
}
```

`-mountingTransactionDidMount` runs `-_remountChildren` before the adjustment. With `removeClippedSubviews`, a prepend moves the anchor out of the clip rect, so `-_remountChildren` detaches it, and the check returns. But the detached anchor is still a valid anchor: the content view still holds it in `_reactSubviews`, and it already has the new frame. That frame is what 0.87.1 corrects with.

The check isn't needed to catch deleted views. The registry resets a view's tag to 0 when it's enqueued ([RCTComponentViewRegistry.mm#L67-L68](https://github.com/react/react-native/blob/bf62cce504e/packages/react-native/React/Fabric/Mounting/RCTComponentViewRegistry.mm#L67-L68)), so the tag check just above already returns for those.

#### Fix

Remove the check. PR to follow.

### Steps to reproduce

1. `git clone https://github.com/mozzius/scrollview-mvcp-anchor-repro && cd scrollview-mvcp-anchor-repro/ReproducerApp && yarn install`
2. `cd ios && bundle install && RCT_USE_PREBUILT_RNCORE=0 bundle exec pod install && cd ..` (core must be built from source for the repro's patch to compile in)
3. `yarn start`, then `yarn ios`
4. Open **B: unmounted**, turn **Clip** on, set **Guard** to `main`, and tap **Prepend**. It reports `+2400.0pt: JUMPED`.
5. Set **Guard** to `0.87.1` or `fix` and tap **Prepend**. It reports `+0.0pt: held`.

The repro's `App.tsx` in an unmodified 0.88.0-rc.4 app shows the same jump at step 4.

### React Native Version

0.88.0-rc.4 and `main`. Not 0.87.1.

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

0.88 was checked on the same machine with `react-native@0.88.0-rc.4`, on the iOS Simulator (iPhone 17 Pro, iOS 26.5).

### Stacktrace or Logs

```text
// 0.87.1's guard: the detached anchor is corrected
[mvcp] adjust guardMode=0 offset=2000.0 contentH=22773.0 anchor=alive tag=6320/6320 attached=NO prevY=1851.0 newY=4251.0
[mvcp] adjust corrected deltaY=+2400.0 offset 2000.0 -> 4400.0
// main's guard
[mvcp] adjust guardMode=1 offset=2000.0 contentH=22773.0 anchor=alive tag=7212/7212 attached=NO prevY=1851.0 newY=4251.0
[mvcp] adjust bail: anchor not a subview of the content view (main)
```

The full logs are in the repro's [`evidence/`](https://github.com/mozzius/scrollview-mvcp-anchor-repro/tree/main/evidence).

### MANDATORY Reproducer

https://github.com/mozzius/scrollview-mvcp-anchor-repro

### Screenshots and Videos

- [`ios-clipped-anchor-0.88.0-rc.4.mp4`](https://github.com/mozzius/scrollview-mvcp-anchor-repro/blob/main/evidence/ios-clipped-anchor-0.88.0-rc.4.mp4): unmodified 0.88.0-rc.4.
- [`ios-clipped-anchor.mp4`](https://github.com/mozzius/scrollview-mvcp-anchor-repro/blob/main/evidence/ios-clipped-anchor.mp4): the 0.87.1 repro, switching between the guards.
