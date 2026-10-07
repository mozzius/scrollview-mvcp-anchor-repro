/**
 * ScrollView `maintainVisibleContentPosition` on iOS (Fabric): two ways the
 * native anchor goes wrong. See README.md.
 *
 * A. Spacer anchor: after a prepend, a VirtualizedList spacer straddles the
 *    top edge of the viewport and is picked as the anchor. Its origin never
 *    moves, so when it is re-estimated nothing is corrected.
 * B. Unmounted anchor: the anchor is recycled (0.87.1) or, with
 *    removeClippedSubviews, clipped (main) in the same transaction that
 *    moves it.
 *
 * @format
 */

import { ComponentRef, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  Settings,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

const JS_STARTED_AT = Date.now();

/*
 * The native patch (patches/react-native+0.87.1.patch) reads these from
 * NSUserDefaults on every mount, so they can be flipped at runtime. Every
 * launch starts on stock 0.87.1 behaviour.
 */
type AnchorMode = 0 | 1 | 2;
type GuardMode = 0 | 1 | 2;
const ANCHOR_LABELS: Record<AnchorMode, string> = {
  0: 'stock',
  1: 'proto',
  2: 'fix',
};
const GUARD_LABELS: Record<GuardMode, string> = {
  0: '0.87.1',
  1: 'main',
  2: 'fix',
};
const PING = `${JS_STARTED_AT}-${Math.random()}`;
Settings.set({
  MVCPReproAnchorMode: 0,
  MVCPReproGuardMode: 0,
  MVCPReproPing: PING,
});

/** The patched native code echoes the ping back, if it was compiled in. */
function patchCompiledIn(): boolean {
  return Settings.get('MVCPReproPong') === PING;
}

type Row = { id: string; height: number; label: string };
type ViewRef = ComponentRef<typeof View>;

/** Deterministic but varied row height in [60, 600], seeded with `n`. */
/* eslint-disable no-bitwise */
function mixedHeight(n: number): number {
  let t = (n * 7919 + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return 60 + Math.round(r * 540);
}
/* eslint-enable no-bitwise */

function makeRows(
  firstId: number,
  count: number,
  height: (id: number) => number,
): Row[] {
  return Array.from({ length: count }, (_, i) => {
    const id = firstId + i;
    return { id: String(id), height: height(id), label: `row ${id}` };
  });
}

function log(message: string) {
  console.log(`[repro] +${Date.now() - JS_STARTED_AT}ms ${message}`);
}

function fmt(n: number) {
  return (n >= 0 ? '+' : '') + n.toFixed(1);
}

/*
 * Scroll stats live outside React, so updating them never re-renders a list.
 * The readout polls them.
 */
const stats = {
  y: 0,
  h: 0,
  /** Events where the offset moved with the content height: an mVCP correction. */
  corrections: 0,
  verdict: '',
  bad: false,
};

function resetStats() {
  stats.y = 0;
  stats.h = 0;
  stats.corrections = 0;
  stats.verdict = '';
  stats.bad = false;
}

/*
 * Read-only diagnostics: VirtualizedList's render window, from private
 * fields. Only used in log lines.
 */
let diagnosticList: FlatList<Row> | null = null;
function vlWindow(): string {
  const vl = (diagnosticList as any)?._listRef;
  const window = vl?.state?.cellsAroundViewport;
  return window ? ` vl=[${window.first},${window.last}]` : '';
}

function onScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
  const y = e.nativeEvent.contentOffset.y;
  const h = e.nativeEvent.contentSize.height;
  const dy = y - stats.y;
  const dh = stats.h === 0 ? 0 : h - stats.h;
  stats.y = y;
  stats.h = h;
  let tag = '';
  if (Math.abs(dh) >= 1 && Math.abs(dy - dh) <= 1) {
    stats.corrections++;
    tag = ` correction #${stats.corrections}`;
  }
  if (Math.abs(dy) >= 0.5 || dh !== 0) {
    log(
      `scroll y=${y.toFixed(1)} (dy=${fmt(dy)}) h=${h.toFixed(1)} (dh=${fmt(
        dh,
      )})${tag}${vlWindow()}`,
    );
  }
}

function onContentSizeChange(_w: number, h: number) {
  log(`contentSize h=${h.toFixed(1)}${vlWindow()}`);
}

/** Screen y of a mounted view, or null if it isn't mounted. */
function measureY(view: ViewRef | null | undefined): Promise<number | null> {
  return new Promise(resolve => {
    if (!view) {
      resolve(null);
      return;
    }
    view.measureInWindow((_x, y, _w, h) => resolve(h > 0 ? y : null));
  });
}

/** Records where the landmark is now, and returns a function that reports how far it moved. */
async function trackLandmark(
  name: string,
  view: () => ViewRef | null | undefined,
): Promise<() => Promise<void>> {
  const before = await measureY(view());
  log(`landmark ${name} at screen y=${before?.toFixed(1)}`);
  return async () => {
    const after = await measureY(view());
    if (before == null || after == null) {
      stats.bad = true;
      stats.verdict = `${name} is not on screen: LOST`;
      log(`verdict: ${name} is not on screen (offset ${stats.y.toFixed(1)})`);
      return;
    }
    const drift = after - before;
    stats.bad = Math.abs(drift) > 1;
    stats.verdict = `${name} moved ${fmt(drift)}pt: ${
      stats.bad ? 'JUMPED' : 'held'
    }`;
    log(
      `verdict: ${name} at screen y=${after.toFixed(1)}, moved ${fmt(drift)}`,
    );
  };
}

function useTicker(ms: number) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(n => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

function Readout({ title }: { title: string }) {
  useTicker(100);
  return (
    <View style={styles.readout}>
      <Text style={[styles.readoutText, styles.bold]}>{title}</Text>
      {!patchCompiledIn() && (
        <Text style={[styles.readoutText, styles.badText]}>
          native patch not active yet (or prebuilt core)
        </Text>
      )}
      <Text style={styles.readoutText}>
        offset {stats.y.toFixed(1)} · content {stats.h.toFixed(1)} · corr{' '}
        {stats.corrections}
      </Text>
      <Text
        style={[
          styles.readoutText,
          styles.bold,
          stats.bad ? styles.badText : styles.goodText,
        ]}
      >
        {stats.verdict || ' '}
      </Text>
    </View>
  );
}

function RowView({
  item,
  highlight,
  rowRef,
}: {
  item: Row;
  highlight?: boolean;
  rowRef?: (view: ViewRef | null) => void;
}) {
  const n = Math.abs(Number(item.id.replace(/[^\d-]/g, '')) || 0);
  return (
    <View
      ref={rowRef}
      collapsable={false}
      style={[
        styles.row,
        {
          height: item.height,
          backgroundColor: highlight
            ? '#fde047'
            : `hsl(${(n * 47) % 360}, 60%, ${
                item.id.startsWith('-') ? 93 : 84
              }%)`,
        },
      ]}
    >
      <Text style={styles.rowText}>
        {item.label} · {item.height}pt
        {highlight ? ' · LANDMARK' : ''}
      </Text>
    </View>
  );
}

function ControlButton({
  label,
  onPress,
  selected,
}: {
  label: string;
  onPress: () => void;
  selected?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        selected && styles.selected,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.buttonText, selected && styles.selectedText]}>
        {label}
      </Text>
    </Pressable>
  );
}

function Toggle({
  label,
  value,
  onValueChange,
}: {
  label: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.toggle}>
      <Text style={styles.buttonText}>{label}</Text>
      <Switch
        accessibilityLabel={label}
        value={value}
        onValueChange={onValueChange}
      />
    </View>
  );
}

function useTimers() {
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  return {
    clear: () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    },
    after: (ms: number, fn: () => void) => {
      timers.current.push(setTimeout(fn, ms));
    },
  };
}

/* ---------------------------------------------------------------------- */
/* A. Spacer anchor                                                        */
/* ---------------------------------------------------------------------- */

const A_INITIAL_ROWS = 100;
const A_PREPEND_ROWS = 20;
const A_PREPEND_HEIGHT = 60;
const A_LANDMARK = '0';

function ListHeader() {
  return (
    <View style={styles.header}>
      <Text style={styles.headerText}>ListHeaderComponent · 120pt</Text>
    </View>
  );
}

function SpacerAnchorScreen({ modes }: { modes: string }) {
  const [header, setHeader] = useState(true);
  const [runId, setRunId] = useState(0);
  const [rows, setRows] = useState(() =>
    makeRows(0, A_INITIAL_ROWS, mixedHeight),
  );
  const landmark = useRef<ViewRef | null>(null);
  const timers = useTimers();

  const reset = () => {
    timers.clear();
    resetStats();
    setRows(makeRows(0, A_INITIAL_ROWS, mixedHeight));
    setRunId(n => n + 1);
  };

  /** At the top of the list, prepend short rows and watch the first row. */
  const run = () => {
    reset();
    log(`run A: ${modes}, header ${header ? 'on' : 'off'}`);
    timers.after(2500, async () => {
      const report = await trackLandmark(
        `row ${A_LANDMARK}`,
        () => landmark.current,
      );
      stats.verdict = 'prepending…';
      log(
        `prepending ${A_PREPEND_ROWS} rows of ${A_PREPEND_HEIGHT}pt at y=${stats.y.toFixed(
          1,
        )} h=${stats.h.toFixed(1)}`,
      );
      setRows(prev => [
        ...makeRows(-A_PREPEND_ROWS, A_PREPEND_ROWS, () => A_PREPEND_HEIGHT),
        ...prev,
      ]);
      timers.after(3000, report);
    });
  };

  return (
    <>
      <View style={styles.controls}>
        <ControlButton label="Run" onPress={run} />
        <ControlButton label="Reset" onPress={reset} />
        <Toggle
          label="ListHeaderComponent"
          value={header}
          onValueChange={value => {
            setHeader(value);
            reset();
          }}
        />
      </View>
      <Readout title={`A: spacer anchor · ${modes}`} />
      <FlatList
        key={runId}
        ref={ref => {
          diagnosticList = ref;
        }}
        style={styles.list}
        data={rows}
        keyExtractor={item => item.id}
        renderItem={({ item }) =>
          item.id === A_LANDMARK ? (
            <RowView
              item={item}
              highlight
              rowRef={view => {
                landmark.current = view;
              }}
            />
          ) : (
            <RowView item={item} />
          )
        }
        ListHeaderComponent={header ? ListHeader : undefined}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        /*
         * Not needed for the bug: stock loses the position the same way
         * without it. With the default (10), once the native fix has held the
         * anchor, VirtualizedList maps the corrected offset through
         * avg * index estimates and renders a 10-cell window that leaves the
         * anchor out, a separate JS issue. A larger batch keeps the anchor
         * mounted, so the native fix can be seen on its own.
         */
        maxToRenderPerBatch={30}
        onScroll={onScroll}
        onContentSizeChange={onContentSizeChange}
        scrollEventThrottle={16}
      />
    </>
  );
}

/* ---------------------------------------------------------------------- */
/* B. Unmounted anchor                                                     */
/* ---------------------------------------------------------------------- */

const B_ROWS = 60;
const B_SCROLL_TO = 2000;
const B_PREPEND_ROWS = 12;
const B_PREPEND_HEIGHT = 200;

/** The row native mVCP anchors on: the first one whose bottom is below the offset. */
function anchorIndex(list: Row[], offset: number): number {
  let top = 0;
  for (let i = 0; i < list.length; i++) {
    top += list[i].height;
    if (top > offset) {
      return i;
    }
  }
  return 0;
}

function UnmountedAnchorScreen({ modes }: { modes: string }) {
  const [clip, setClip] = useState(false);
  /*
   * removeClippedSubviews is switched on just after each mount rather than
   * passed at mount. A content view that comes out of the recycle pool, and
   * had removeClippedSubviews in its previous life too, never re-enables
   * clipping: prepareForRecycle resets the flag but updateProps diffs against
   * the stale props. That separate bug would hide this one.
   */
  const [clipReady, setClipReady] = useState(false);
  const [runId, setRunId] = useState(0);
  const [rows, setRows] = useState(() => makeRows(0, B_ROWS, mixedHeight));
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const rowRefs = useRef(new Map<string, ViewRef | null>());
  const timers = useTimers();

  useEffect(() => {
    const frame = requestAnimationFrame(() => setClipReady(true));
    return () => cancelAnimationFrame(frame);
  }, [runId]);

  const reset = () => {
    timers.clear();
    resetStats();
    setClipReady(false);
    setRows(makeRows(0, B_ROWS, mixedHeight));
    setRunId(n => n + 1);
  };

  /**
   * Scroll down to B_SCROLL_TO, apply `mutate` in one update, and watch the
   * row below the anchor.
   */
  const run = (name: string, mutate: (list: Row[]) => Row[]) => {
    reset();
    log(`run B ${name}: ${modes}, removeClippedSubviews ${clip}`);
    timers.after(800, () => {
      scrollRef.current?.scrollTo({ y: B_SCROLL_TO, animated: false });
    });
    timers.after(1600, async () => {
      const initial = makeRows(0, B_ROWS, mixedHeight);
      const landmarkId = initial[anchorIndex(initial, B_SCROLL_TO) + 1].id;
      const report = await trackLandmark(`row ${landmarkId}`, () =>
        rowRefs.current.get(landmarkId),
      );
      stats.verdict = `${name}…`;
      setRows(list => mutate(list));
      timers.after(2000, report);
    });
  };

  /*
   * The anchor row is removed, and a row is prepended, in one update. The
   * anchor's view goes back to the recycle pool and is handed straight out
   * again for the new row at the top.
   */
  const removeAndPrepend = () =>
    run('remove anchor row + prepend 1', list => {
      const index = anchorIndex(list, B_SCROLL_TO);
      log(`removing row ${list[index].id}, and prepending 1 row of 100pt`);
      return [
        { id: '-1', height: 100, label: 'row -1' },
        ...list.slice(0, index),
        ...list.slice(index + 1),
      ];
    });

  /** More than a screen of rows, prepended in one update. */
  const prepend = () =>
    run(`prepend ${B_PREPEND_ROWS * B_PREPEND_HEIGHT}pt`, list => {
      log(`prepending ${B_PREPEND_ROWS} rows of ${B_PREPEND_HEIGHT}pt`);
      return [
        ...makeRows(-B_PREPEND_ROWS, B_PREPEND_ROWS, () => B_PREPEND_HEIGHT),
        ...list,
      ];
    });

  return (
    <>
      <View style={styles.controls}>
        <ControlButton label="Remove+prepend" onPress={removeAndPrepend} />
        <ControlButton label="Prepend" onPress={prepend} />
        <Toggle
          label="Clip"
          value={clip}
          onValueChange={value => {
            setClip(value);
            reset();
          }}
        />
      </View>
      <Readout
        title={`B: unmounted anchor · ${modes} · clip ${clip ? 'on' : 'off'}`}
      />
      <ScrollView
        key={runId}
        ref={scrollRef}
        style={styles.list}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        removeClippedSubviews={clip && clipReady}
        onScroll={onScroll}
        scrollEventThrottle={16}
      >
        {rows.map(row => (
          <RowView
            key={row.id}
            item={row}
            rowRef={view => {
              rowRefs.current.set(row.id, view);
            }}
          />
        ))}
      </ScrollView>
    </>
  );
}

/* ---------------------------------------------------------------------- */
/* C. Control: insert below a straddling row                               */
/* ---------------------------------------------------------------------- */

const C_INSERT_ROWS = 3;
const C_INSERT_HEIGHT = 150;

/**
 * Rows inserted directly below the row the top edge cuts through. This is the
 * case #43203 chose the first partially visible view for: stock keeps the
 * straddling row where it is and shows the new rows below it.
 */
function InsertBelowScreen({ modes }: { modes: string }) {
  const [runId, setRunId] = useState(0);
  const [rows, setRows] = useState(() => makeRows(0, B_ROWS, mixedHeight));
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const rowRefs = useRef(new Map<string, ViewRef | null>());
  const timers = useTimers();

  const reset = () => {
    timers.clear();
    resetStats();
    setRows(makeRows(0, B_ROWS, mixedHeight));
    setRunId(n => n + 1);
  };

  const run = () => {
    reset();
    log(`run C: ${modes}`);
    timers.after(800, () => {
      scrollRef.current?.scrollTo({ y: B_SCROLL_TO, animated: false });
    });
    timers.after(1600, async () => {
      const initial = makeRows(0, B_ROWS, mixedHeight);
      const index = anchorIndex(initial, B_SCROLL_TO);
      const straddling = initial[index].id;
      const report = await trackLandmark(`row ${straddling}`, () =>
        rowRefs.current.get(straddling),
      );
      stats.verdict = 'inserting…';
      log(
        `inserting ${C_INSERT_ROWS} rows of ${C_INSERT_HEIGHT}pt below row ${straddling}`,
      );
      setRows(list => [
        ...list.slice(0, index + 1),
        ...Array.from({ length: C_INSERT_ROWS }, (_, i) => ({
          id: `new-${i}`,
          height: C_INSERT_HEIGHT,
          label: `inserted ${i}`,
        })),
        ...list.slice(index + 1),
      ]);
      timers.after(2000, report);
    });
  };

  return (
    <>
      <View style={styles.controls}>
        <ControlButton label="Insert below" onPress={run} />
        <ControlButton label="Reset" onPress={reset} />
      </View>
      <Readout title={`C: insert below the top row · ${modes}`} />
      <ScrollView
        key={runId}
        ref={scrollRef}
        style={styles.list}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        onScroll={onScroll}
        scrollEventThrottle={16}
      >
        {rows.map(row => (
          <RowView
            key={row.id}
            item={row}
            rowRef={view => {
              rowRefs.current.set(row.id, view);
            }}
          />
        ))}
      </ScrollView>
    </>
  );
}

function App() {
  const [screen, setScreen] = useState<'A' | 'B' | 'C'>('A');
  const [anchor, setAnchor] = useState<AnchorMode>(0);
  const [guard, setGuard] = useState<GuardMode>(0);
  const modes = `anchor ${ANCHOR_LABELS[anchor]} · guard ${GUARD_LABELS[guard]}`;
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.controls}>
          <ControlButton
            label="A: spacer"
            selected={screen === 'A'}
            onPress={() => {
              resetStats();
              setScreen('A');
            }}
          />
          <ControlButton
            label="B: unmounted"
            selected={screen === 'B'}
            onPress={() => {
              resetStats();
              setScreen('B');
            }}
          />
          <ControlButton
            label="C: control"
            selected={screen === 'C'}
            onPress={() => {
              resetStats();
              setScreen('C');
            }}
          />
        </View>
        <View style={styles.controls}>
          <Text style={styles.label}>Anchor</Text>
          {([0, 1, 2] as AnchorMode[]).map(mode => (
            <ControlButton
              key={mode}
              label={ANCHOR_LABELS[mode]}
              selected={anchor === mode}
              onPress={() => {
                setAnchor(mode);
                Settings.set({ MVCPReproAnchorMode: mode });
              }}
            />
          ))}
        </View>
        <View style={styles.controls}>
          <Text style={styles.label}>Guard</Text>
          {([0, 1, 2] as GuardMode[]).map(mode => (
            <ControlButton
              key={mode}
              label={GUARD_LABELS[mode]}
              selected={guard === mode}
              onPress={() => {
                setGuard(mode);
                Settings.set({ MVCPReproGuardMode: mode });
              }}
            />
          ))}
        </View>
        {screen === 'A' ? (
          <SpacerAnchorScreen modes={modes} />
        ) : screen === 'B' ? (
          <UnmountedAnchorScreen modes={modes} />
        ) : (
          <InsertBelowScreen modes={modes} />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'white' },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  button: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: '#e5e7eb',
  },
  selected: { backgroundColor: '#1d4ed8' },
  selectedText: { color: 'white' },
  pressed: { opacity: 0.6 },
  buttonText: { fontSize: 14, fontWeight: '600' },
  label: { width: 52, fontSize: 13, color: '#555' },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  readout: {
    paddingHorizontal: 10,
    paddingBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: '#999',
  },
  readoutText: {
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    fontSize: 13,
    lineHeight: 18,
  },
  bold: { fontWeight: '700' },
  badText: { color: '#dc2626' },
  goodText: { color: '#15803d' },
  list: { flex: 1 },
  header: {
    height: 120,
    justifyContent: 'center',
    paddingHorizontal: 16,
    backgroundColor: '#1f2937',
  },
  headerText: { color: 'white', fontSize: 16, fontWeight: '600' },
  row: {
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: '#666',
  },
  rowText: { fontSize: 16 },
});

export default App;
