// Sokoban solver for make.fun sokoban-solver-01-run-20261121.
//
// Own design, written from scratch in this session:
//  - Push-based A* over box configurations (one node per push, not per step),
//    with the player's reachable region folded into the state key so walks
//    between pushes cost no search.
//  - Admissible heuristic: the cheapest assignment of boxes to goals under
//    shortest-path distances that ignore the other boxes (exact min-cost
//    matching for the small box counts here, sum-of-nearest otherwise).
//  - Pruning: dead squares (a box that can never be pushed onto a goal),
//    frozen 2x2 blocks of walls and boxes, and a per-search node budget
//    (work, never the clock) so two runs always write the same bytes.
//  - Decomposition: the generator lays a one-wide hallway with rooms off it
//    and a box pushed into the hallway can never come back, so the hallway
//    squares are dead for boxes; cutting them out of the floor splits the
//    level into independent rooms, each solved on its own from wherever the
//    player stands, and the level optimum is the sum of the rooms' optima.
//    A room's solution must leave the player able to reach its door again,
//    unless it is the last room, so the rooms concatenate into one walk.
//
// Node 22 runs this as node /bot/main.ts (erasable TypeScript only).
// Reads /input/<id>/level.txt, writes /output/<id>/solution.txt (LURD moves).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The four directions: dx, dy, walk letter, push letter. */
const DIRS: ReadonlyArray<readonly [number, number, string, string]> = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

/** A parsed level. */
interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** The most states one push search keeps before it gives up: work, never the clock. */
const MAX_STATES = 400_000;

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever it shows, so neighbour lookups never leave the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * The squares from which a box alone can be pushed onto some goal: pull back
 * from the goals over open floor (a box on such a square reaches a goal; a box
 * anywhere else is dead and can be pruned).
 */
function liveCells(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Flood the player's reachable region from `from` with `occupied` (boxes) in
 * the way, marking it in `seen` with `stamp`; returns its lowest square, which
 * names the region no matter where in it the player stands.
 */
function regionLow(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block: four squares of walls and boxes holding a box off its goal. */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/**
 * Shortest-path distances over open floor (boxes ignored) from each goal:
 * dist[g][cell]. A box needs at least this many pushes to reach that goal.
 */
function goalDistances(level: Level): number[][] {
  const { w, wall, goals } = level;
  const size = wall.length;
  const out: number[][] = [];
  for (const g of goals) {
    const dist = new Array<number>(size).fill(Infinity);
    const queue = [g];
    dist[g] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi]!;
      for (let k = 0; k < 4; k++) {
        const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
        if (wall[q] === 0 && dist[q] === Infinity) {
          dist[q] = dist[p]! + 1;
          queue.push(q);
        }
      }
    }
    out.push(dist);
  }
  return out;
}

/**
 * Admissible estimate of the pushes still needed: the cheapest way to match
 * every box to a different goal under the distances above (exact assignment
 * by permutation for few boxes, sum of nearest goals for many). Each push
 * moves one box one square, so no solution beats it.
 */
function heuristic(boxes: number[], dist: number[][], nGoals: number): number {
  const n = boxes.length;
  if (n === 0) return 0;
  // More boxes than goals can never be solved.
  if (n > nGoals) return Infinity;
  // Exact min-cost assignment only when every box has exactly one goal to
  // match; otherwise the sum of nearest goals (still admissible).
  if (n !== nGoals || n > 5) {
    let sum = 0;
    for (const b of boxes) {
      let best = Infinity;
      for (let g = 0; g < nGoals; g++) {
        const d = dist[g]![b]!;
        if (d < best) best = d;
      }
      if (best === Infinity) return Infinity;
      sum += best;
    }
    return sum;
  }
  // Exact min-cost assignment over all bijections (n! <= 120).
  const perm = [...Array(n).keys()];
  let best = Infinity;
  const walk = (k: number, acc: number): void => {
    if (acc >= best) return;
    if (k === n) {
      best = acc;
      return;
    }
    for (let i = k; i < n; i++) {
      [perm[k], perm[i]] = [perm[i]!, perm[k]!];
      const d = dist[perm[k]!]![boxes[k]!]!;
      if (d !== Infinity) walk(k + 1, acc + d);
      [perm[k], perm[i]] = [perm[i]!, perm[k]!];
    }
  };
  walk(0, 0);
  return best;
}

/** A binary heap on [f, -g, seq]: lowest f first, deepest g on ties, then oldest. */
class Heap {
  private a: Array<[number, number, number, number]> = [];
  get size(): number {
    return this.a.length;
  }
  push(e: [number, number, number, number]): void {
    const a = this.a;
    let i = a.length;
    a.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!Heap.less(a[i]!, a[p]!)) break;
      [a[i], a[p]] = [a[p]!, a[i]!];
      i = p;
    }
  }
  pop(): [number, number, number, number] {
    const a = this.a;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= a.length) break;
        if (c + 1 < a.length && Heap.less(a[c + 1]!, a[c]!)) c++;
        if (!Heap.less(a[c]!, a[i]!)) break;
        [a[i], a[c]] = [a[c]!, a[i]!];
        i = c;
      }
    }
    return top;
  }
  private static less(x: [number, number, number, number], y: [number, number, number, number]): boolean {
    return x[0] < y[0] || (x[0] === y[0] && (x[1] < y[1] || (x[1] === y[1] && x[2] < y[2])));
  }
}

/** The shortest walk from `from` to `to` around walls and boxes, lower LURD letters (first direction first on ties). */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

interface SearchResult {
  pushes: number;
  moves: string;
}

/**
 * The push-optimal solution of `level` by A* over pushes, or null when the
 * search gives up (budget) or the level has no solution. A state is the
 * boxes' squares plus the player's reachable region; the first solved state
 * popped from the open list is optimal, because the heuristic never
 * overestimates. `exitCells` (when given) names squares the player must be
 * able to reach once solved, so a room's answer leaves the player free to
 * walk on to the next room; a solved state that strands the player is passed
 * over for the next one.
 */
function searchPushOptimal(
  level: Level,
  maxStates: number = MAX_STATES,
  exitCells: number[] | null = null,
): SearchResult | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveCells(level);
  const dist = goalDistances(level);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (level.boxes.some((b) => !live[b])) return null;

  const sBoxes: number[][] = [level.boxes];
  const sPlayer: number[] = [level.player];
  const sParent: number[] = [-1];
  const sFrom: number[] = [-1]; // the pushed box's square before the push that made this state
  const sTo: number[] = [-1]; // ... and after it
  const sG: number[] = [0];
  const best = new Map<string, number>();
  for (const b of level.boxes) occupied[b] = 1;
  const key0 = `${regionLow(level, occupied, level.player, seen, ++stamp, stack)}|${level.boxes.join(',')}`;
  for (const b of level.boxes) occupied[b] = 0;
  best.set(key0, 0);
  const heap = new Heap();
  let seq = 0;
  const h0 = heuristic(level.boxes, dist, goals.length);
  if (h0 === Infinity) return null;
  heap.push([h0, 0, seq++, 0]);

  const canExit = (player: number, boxes: number[]): boolean => {
    if (exitCells === null) return true;
    for (const b of boxes) occupied[b] = 1;
    const low = regionLow(level, occupied, player, seen, ++stamp, stack);
    void low;
    // Re-run the flood and check the exit cells against its stamp.
    const stampHere = stamp;
    let ok = false;
    for (const e of exitCells) if (seen[e] === stampHere) ok = true;
    for (const b of boxes) occupied[b] = 0;
    return ok;
  };

  let found = -1;
  while (heap.size > 0) {
    const [, negG, , s] = heap.pop();
    const g = -negG;
    const boxes = sBoxes[s]!;
    if (best.get(`${regionLow(level, (() => { for (const b of boxes) occupied[b] = 1; return occupied; })(), sPlayer[s]!, seen, ++stamp, stack)}|${boxes.join(',')}`) !== g) {
      for (const b of boxes) occupied[b] = 0;
      continue;
    }
    for (const b of boxes) occupied[b] = 0;
    if (solved(boxes)) {
      if (canExit(sPlayer[s]!, boxes)) {
        found = s;
        break;
      }
      continue; // solved but strands the player: pass it over, keep searching
    }
    // Expand: every push the player can make from this region.
    for (const b of boxes) occupied[b] = 1;
    regionLow(level, occupied, sPlayer[s]!, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key = '';
        let next: number[] | null = null;
        let h = Infinity;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, z) => a - z);
          key = `${regionLow(level, occupied, b, mark, ++stamp, stack)}|${next.join(',')}`;
          h = heuristic(next, dist, goals.length);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || h === Infinity) continue;
        const ng = g + 1;
        const prev = best.get(key);
        if (prev !== undefined && prev <= ng) continue;
        if (sBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        best.set(key, ng);
        sBoxes.push(next);
        sPlayer.push(b);
        sParent.push(s);
        sFrom.push(b);
        sTo.push(t);
        sG.push(ng);
        heap.push([ng + h, -ng, seq++, sBoxes.length - 1]);
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const from = sFrom[s]!;
    const to = sTo[s]!;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[3];
    player = from;
    const nextBoxes = sBoxes[s]!;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

/** The square the player stands on after `moves` (LURD, case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  doorCells: number[];
  done: boolean;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each part left that holds
 * a box is a room. Null when some part holds more or fewer boxes than goals,
 * a goal falls in the cut, or a box starts in the hallway: then the level is
 * no set of rooms.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveCells(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], doorCells: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  for (const r of rooms) {
    for (const s of r.squares) {
      for (const [dx, dy] of DIRS) {
        const q = s + dy * w + dx;
        if (cut[q]) {
          r.doorCells.push(s);
          break;
        }
      }
    }
  }
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The level solved room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room is
 * done), the player walking on from where the last room left it. A box never
 * leaves its room (a push through a door lands it in the hallway, where it
 * reaches no goal), so the rooms' optima add up to the level's. Null when a
 * room's search gives up, or the level is no set of rooms and the search over
 * the whole level gives up.
 */
function solveByRooms(level: Level): SearchResult | null {
  const rooms = roomsOf(level);
  if (rooms === null) return searchPushOptimal(level);
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri]!;
    const last = ri === rooms.length - 1;
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = searchPushOptimal(sub, MAX_STATES, last ? null : room.doorCells);
    if (solved === null) return searchPushOptimal(level);
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/** The moves for a level in XSB: a string of u, d, l and r (an upper letter marks a push). */
function solve(text: string): string {
  const level = parseLevel(text);
  if (level.boxes.every((b) => level.goals.includes(b))) return '';
  const solved = solveByRooms(level);
  return solved === null ? '' : solved.moves;
}

for (const id of readdirSync(I).sort()) {
  // One bad instance must never take the whole set down with it: an answer
  // that is empty is valid and worth 0, a crash is worth nothing anywhere.
  let moves = '';
  try {
    moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
