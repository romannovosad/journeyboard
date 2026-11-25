/**
 * Lays out a journey board: one lane per flow, a card per screen on a grid, and arrows from the order the tests
 * walk through the screens. Pure and deterministic: the same screens give the same board, whatever order they come
 * in. Positions are grid cells (`col`, `row`); the viewer turns them into pixels.
 *
 *   buildBoard({ screens, mockups }) → { cols, rows, lanes, cards, mockups, arrows }
 *
 * - Arrows: consecutive snaps within one test, plus a screen's `from`. Each is drawn once; one that names a screen
 *   not on the board is dropped.
 * - Lanes: flows ordered by how early the walk reaches them, so arrows between lanes mostly point down.
 * - Columns: a screen's longest path from the start of its lane, so a fork puts its branches in the same column.
 * - Rows: a screen keeps its predecessor's row when it is free, so a walk reads as a straight line and a fork stacks
 *   its other branch below.
 * - Mockups sit under their target screen, in extra rows of its lane. Mockups whose screen isn't captured yet get a
 *   lane of their own at the end (`flow: null`).
 */
import { screenKey } from './lib.mjs';

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Sort key that keeps a test's screens together and in walking order. */
const walkOrder = (a, b) =>
  byText(a.test ?? '', b.test ?? '') ||
  byText(a.testTitle ?? '', b.testTitle ?? '') ||
  (Number(a.order) || 0) - (Number(b.order) || 0) ||
  byText(screenKey(a), screenKey(b));

/** Arrows `{ from, to }` (screen keys), deduplicated, sorted. */
export function edgesFor(screens) {
  const keys = new Set(screens.map(screenKey));
  const tests = new Map();
  const edges = new Map();
  const add = (from, to) => {
    if (from !== to && keys.has(from) && keys.has(to)) {
      edges.set(`${from}\n${to}`, { from, to });
    }
  };

  for (const s of screens) {
    const test = `${s.test ?? ''}\n${s.testTitle ?? ''}`;

    tests.set(test, [...(tests.get(test) ?? []), s]);
  }

  for (const walk of tests.values()) {
    walk.sort(walkOrder);

    for (let i = 1; i < walk.length; i += 1) {
      add(screenKey(walk[i - 1]), screenKey(walk[i]));
    }
  }

  for (const s of screens) {
    if (s.from) {
      add(s.from, screenKey(s));
    }
  }

  return [...edges.values()].sort((a, b) => byText(a.from, b.from) || byText(a.to, b.to));
}

/** The edges minus those that close a cycle, found by a depth-first walk in a fixed order. */
function withoutCycles(nodes, edges) {
  const out = new Map(nodes.map((n) => [n, []]));
  const hasIncoming = new Set(edges.map((e) => e.to));
  const state = new Map();
  const keep = [];

  for (const e of edges) {
    out.get(e.from).push(e);
  }
  const visit = (node) => {
    state.set(node, 'open');

    for (const e of out.get(node)) {
      if (state.get(e.to) === 'open') {
        continue;
      }
      keep.push(e);

      if (!state.has(e.to)) {
        visit(e.to);
      }
    }
    state.set(node, 'done');
  };

  // Start from screens nothing leads to, so a cycle is cut where the walk re-enters it.
  for (const node of [...nodes.filter((n) => !hasIncoming.has(n)), ...nodes]) {
    if (!state.has(node)) {
      visit(node);
    }
  }

  return keep;
}

/** Longest path from any start, over acyclic edges. */
function depths(nodes, edges) {
  const depth = new Map(nodes.map((n) => [n, 0]));
  const incoming = new Map(nodes.map((n) => [n, 0]));
  const out = new Map(nodes.map((n) => [n, []]));

  for (const e of edges) {
    incoming.set(e.to, incoming.get(e.to) + 1);
    out.get(e.from).push(e.to);
  }
  const ready = nodes.filter((n) => incoming.get(n) === 0);

  while (ready.length) {
    const node = ready.shift();

    for (const next of out.get(node)) {
      depth.set(next, Math.max(depth.get(next), depth.get(node) + 1));
      incoming.set(next, incoming.get(next) - 1);

      if (incoming.get(next) === 0) {
        ready.push(next);
      }
    }
  }

  return depth;
}

export function buildBoard({ screens, mockups = [] }) {
  const sorted = [...screens].sort(walkOrder);
  const byKey = new Map(sorted.map((s) => [screenKey(s), s]));
  const nodes = [...byKey.keys()];
  const arrows = edgesFor(sorted);
  const acyclic = withoutCycles(nodes, arrows);
  const reach = depths(nodes, acyclic);

  // Lanes: start with the flows the walk reaches first; each flow is followed by the flows its arrows lead into, so
  // a walk that moves on to another flow reads downwards and related lanes sit together.
  const firstReached = (flow) => Math.min(...nodes.filter((n) => byKey.get(n).flow === flow).map((n) => reach.get(n)));
  const flowOrder = (a, b) => firstReached(a) - firstReached(b) || byText(a, b);
  const allFlows = [...new Set(sorted.map((s) => s.flow))].sort(flowOrder);
  const leadsInto = new Map(allFlows.map((f) => [f, new Set()]));

  for (const e of acyclic) {
    const [a, b] = [byKey.get(e.from).flow, byKey.get(e.to).flow];

    if (a !== b) leadsInto.get(a).add(b);
  }
  const flows = [];
  const placeFlow = (flow) => {
    if (flows.includes(flow)) return;
    flows.push(flow);
    [...leadsInto.get(flow)].sort(flowOrder).forEach(placeFlow);
  };

  allFlows.forEach(placeFlow);

  const cards = [];
  const placedMockups = [];
  const lanes = [];
  const at = new Map();
  let top = 0;
  let cols = 0;

  for (const flow of flows) {
    const laneNodes = nodes.filter((n) => byKey.get(n).flow === flow);
    const inLane = acyclic.filter((e) => byKey.get(e.from).flow === flow && byKey.get(e.to).flow === flow);
    const col = depths(laneNodes, inLane);
    const taken = new Set();
    const rowOf = new Map();
    let rows = 1;

    const sameTest = (a, b) => a.test === b.test && a.testTitle === b.testTitle;
    const preferred = (n) => {
      const before = inLane.filter((e) => e.to === n).map((e) => e.from);
      const want = before.length ? Math.min(...before.map((p) => rowOf.get(p))) : 0;
      // At a fork the screen that continues the same test keeps the row; a branching test moves down.
      const continues = before.some((p) => rowOf.get(p) === want && sameTest(byKey.get(p), byKey.get(n)));

      return { want, continues };
    };

    for (const c of [...new Set(col.values())].sort((a, b) => a - b)) {
      const here = laneNodes
        .filter((n) => col.get(n) === c)
        .map((n) => ({ n, ...preferred(n) }))
        .sort(
          (a, b) =>
            a.want - b.want || Number(b.continues) - Number(a.continues) || walkOrder(byKey.get(a.n), byKey.get(b.n))
        );

      for (const { n, want } of here) {
        let row = want;

        while (taken.has(`${c},${row}`)) row += 1;
        taken.add(`${c},${row}`);
        rowOf.set(n, row);
        rows = Math.max(rows, row + 1);
      }
    }

    for (const n of laneNodes) {
      const card = { ...byKey.get(n), key: n, col: col.get(n), row: top + rowOf.get(n) };

      cards.push(card);
      at.set(n, card);
      cols = Math.max(cols, card.col + 1);
    }

    // Mockups below their target, stacking when several share a column.
    const stack = new Map();

    for (const m of mockups.filter((x) => byKey.get(x.target)?.flow === flow)) {
      const c = col.get(m.target);
      const extra = stack.get(c) ?? 0;

      stack.set(c, extra + 1);
      placedMockups.push({ ...m, col: c, row: top + rows + extra });
    }
    const mockupRows = Math.max(0, ...stack.values());

    lanes.push({ flow, row: top, rows: rows + mockupRows });
    top += rows + mockupRows;
  }

  const unbuilt = mockups.filter((m) => !byKey.has(m.target));

  if (unbuilt.length) {
    unbuilt.forEach((m, i) => placedMockups.push({ ...m, col: i, row: top }));
    lanes.push({ flow: null, row: top, rows: 1 });
    cols = Math.max(cols, unbuilt.length);
    top += 1;
  }

  cards.sort((a, b) => a.row - b.row || a.col - b.col);

  return { cols, rows: top, lanes, cards, mockups: placedMockups, arrows };
}
