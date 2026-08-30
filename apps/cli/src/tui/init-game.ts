/**
 * Pure, deterministic space-invaders simulation that plays itself while
 * `oxagen init` does real async work in the background (see
 * commands/init.ts's onProgress wiring + tui/init-animation.tsx).
 *
 * Everything here is a pure function of the previous state — no
 * `Math.random()` anywhere — so replaying the same sequence of `{type:
 * "tick"}` actions from the same initial state always produces the same
 * frames (see init-game.test.ts). Mirrors the "pure frame function, no
 * timers" philosophy of repl/components.tsx's renderInvadersLane, extended
 * to persistent multi-entity state via a reducer since (unlike the single
 * rocket/UFO duel) invaders need to be permanently destroyed and remembered.
 *
 * The render side (mapping GameState -> a colored character grid, and that
 * grid -> Ink <Text> elements) lives in init-game-view.tsx.
 */

// ---------------------------------------------------------------------------
// Formation layout
// ---------------------------------------------------------------------------

const GRID = {
  invaderRows: 3,
  invaderCols: 6,
  colSpacing: 2,
  // Empty rows between the formation's starting row and the player's row —
  // how much room the invaders have to visibly descend before a wave resets.
  rowGap: 5,
} as const;

const FORMATION_SPAN = (GRID.invaderCols - 1) * GRID.colSpacing + 1;
const HEIGHT = GRID.invaderRows + GRID.rowGap + 1;

const EXPLOSION_TTL = 2;
const PLAYER_FIRE_INTERVAL = 5;
const INVADER_FIRE_INTERVAL = 7;
const MIN_WIDTH = 26;
const MAX_WIDTH = 44;

function clampWidth(width: number): number {
  return Math.max(MIN_WIDTH, Math.min(width, MAX_WIDTH));
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface Invader {
  readonly id: string;
  /** Column/row offset from the formation origin — fixed for the invader's lifetime. */
  readonly col: number;
  readonly row: number;
  readonly alive: boolean;
}

export interface Bolt {
  readonly col: number;
  readonly row: number;
}

export interface Explosion {
  readonly col: number;
  readonly row: number;
  readonly ttl: number;
}

export interface GameState {
  readonly width: number;
  readonly height: number;
  readonly playerRow: number;
  readonly tick: number;
  readonly originCol: number;
  readonly originRow: number;
  readonly dir: 1 | -1;
  readonly invaders: readonly Invader[];
  readonly playerBolt: Bolt | null;
  readonly invaderBolts: readonly Bolt[];
  readonly explosions: readonly Explosion[];
  readonly score: number;
  readonly wave: number;
}

export type GameAction = { type: "tick" };

function makeInvaders(): Invader[] {
  const list: Invader[] = [];
  for (let r = 0; r < GRID.invaderRows; r++) {
    for (let c = 0; c < GRID.invaderCols; c++) {
      list.push({
        id: `${r}-${c}`,
        col: c * GRID.colSpacing,
        row: r,
        alive: true,
      });
    }
  }
  return list;
}

function formationOriginCol(width: number): number {
  return Math.floor((width - FORMATION_SPAN) / 2);
}

/** Fresh state for a brand-new game: a full formation at the top, player centered, nothing in flight. */
export function createInitialGameState(width = 34): GameState {
  const w = clampWidth(width);
  return {
    width: w,
    height: HEIGHT,
    playerRow: HEIGHT - 1,
    tick: 0,
    originCol: formationOriginCol(w),
    originRow: 0,
    dir: 1,
    invaders: makeInvaders(),
    playerBolt: null,
    invaderBolts: [],
    explosions: [],
    score: 0,
    wave: 1,
  };
}

/**
 * Deterministic player-ship column: a triangle-wave patrol over `tick`,
 * independent of any stored state so the reducer (deciding where a new bolt
 * spawns) and the view (drawing the ship) can never disagree. Pure function
 * of (width, tick) only.
 */
export function playerColAt(width: number, tick: number): number {
  const span = Math.max(4, Math.floor(width * 0.6));
  const left = Math.floor((width - span) / 2);
  const period = span * 2;
  const m = ((tick % period) + period) % period;
  return left + (m <= span ? m : period - m);
}

function aliveInvaders(s: GameState): readonly Invader[] {
  return s.invaders.filter((i) => i.alive);
}

/** An invader's absolute (col, row) given the formation's current origin. */
export function absolute(
  originCol: number,
  originRow: number,
  inv: Invader,
): Bolt {
  return { col: originCol + inv.col, row: originRow + inv.row };
}

/** Start the next wave: a full fresh formation, score and wave count carried forward. */
function resetWave(s: GameState, tick: number): GameState {
  return {
    ...s,
    tick,
    originCol: formationOriginCol(s.width),
    originRow: 0,
    dir: 1,
    invaders: makeInvaders(),
    playerBolt: null,
    invaderBolts: [],
    explosions: [],
    wave: s.wave + 1,
  };
}

/**
 * Ticks between formation moves — speeds up as the wave thins out (classic
 * space-invaders tension). Still a pure function of the alive count, never of
 * wall-clock time or chance.
 */
export function moveInterval(aliveCount: number, total: number): number {
  const destroyed = total - aliveCount;
  return Math.max(2, 6 - Math.floor(destroyed / 6));
}

/** Advance the simulation by exactly one tick. Pure: same input -> same output. */
export function tickGame(s: GameState): GameState {
  const tick = s.tick + 1;
  const alive = aliveInvaders(s);

  if (alive.length === 0) {
    return resetWave(s, tick);
  }

  // ---- formation march: step every `moveInterval` ticks, reverse + descend
  // one row on hitting either wall ----
  let originCol = s.originCol;
  let originRow = s.originRow;
  let dir = s.dir;
  const interval = moveInterval(alive.length, s.invaders.length);
  if (tick % interval === 0) {
    const cols = alive.map((i) => i.col);
    const minCol = originCol + Math.min(...cols);
    const maxCol = originCol + Math.max(...cols);
    if (
      (dir === 1 && maxCol + 1 >= s.width) ||
      (dir === -1 && minCol - 1 < 0)
    ) {
      dir = dir === 1 ? -1 : 1;
      originRow += 1;
    } else {
      originCol += dir;
    }
  }

  // Formation reached the player's row — the wave overran the line. Reset
  // instead of "losing": this is a perpetual attract-mode loop, not a game
  // that can dead-end while init's real work is still running.
  const rows = alive.map((i) => originRow + i.row);
  if (Math.max(...rows) >= s.playerRow) {
    return resetWave(s, tick);
  }

  const playerCol = playerColAt(s.width, tick);

  // ---- explosions decay ----
  const explosions: Explosion[] = s.explosions
    .map((e) => ({ ...e, ttl: e.ttl - 1 }))
    .filter((e) => e.ttl > 0);

  // ---- player bolt: travels up, kills the invader it reaches, or fires fresh ----
  let playerBolt = s.playerBolt;
  // Typed as the mutable array `.slice()` below actually produces — `invaders`
  // only ever gets a fresh clone assigned before any index write, never the
  // shared `s.invaders` reference itself, so this is a safe static widening.
  let invaders: Invader[] = s.invaders as Invader[];
  let score = s.score;
  if (playerBolt) {
    const nextRow = playerBolt.row - 1;
    const hitIdx = invaders.findIndex((i) => {
      if (!i.alive) return false;
      const a = absolute(originCol, originRow, i);
      return a.col === playerBolt!.col && a.row === nextRow;
    });
    if (hitIdx >= 0) {
      invaders = invaders.slice();
      invaders[hitIdx] = { ...invaders[hitIdx]!, alive: false };
      explosions.push({
        col: playerBolt.col,
        row: nextRow,
        ttl: EXPLOSION_TTL,
      });
      score += 10;
      playerBolt = null;
    } else if (nextRow < 0) {
      playerBolt = null; // missed clean off the top
    } else {
      playerBolt = { col: playerBolt.col, row: nextRow };
    }
  } else if (tick % PLAYER_FIRE_INTERVAL === 0) {
    playerBolt = { col: playerCol, row: s.playerRow - 1 };
  }

  // ---- invader bolts: travel down, "hit" the player row at the player's column ----
  let invaderBolts = s.invaderBolts
    .map((b) => ({ col: b.col, row: b.row + 1 }))
    .filter((b) => b.row <= s.playerRow);

  let playerHit = false;
  invaderBolts = invaderBolts.filter((b) => {
    if (b.row === s.playerRow && b.col === playerCol) {
      playerHit = true;
      return false;
    }
    return true;
  });
  if (playerHit) {
    explosions.push({ col: playerCol, row: s.playerRow, ttl: EXPLOSION_TTL });
  }

  const stillAlive = invaders.filter((i) => i.alive);
  if (tick % INVADER_FIRE_INTERVAL === 0 && stillAlive.length > 0) {
    // Deterministic shooter pick: cycle through alive columns by tick, firing
    // from the front-most (highest row offset) invader in that column — no
    // coin flip, matching renderInvadersLane's "pure function of tick" rule.
    const columns = [...new Set(stillAlive.map((i) => i.col))].sort(
      (a, b) => a - b,
    );
    const col =
      columns[Math.floor(tick / INVADER_FIRE_INTERVAL) % columns.length]!;
    const front = [...stillAlive]
      .filter((i) => i.col === col)
      .sort((a, b) => b.row - a.row)[0]!;
    const a = absolute(originCol, originRow, front);
    invaderBolts = [...invaderBolts, { col: a.col, row: a.row + 1 }];
  }

  return {
    ...s,
    tick,
    originCol,
    originRow,
    dir,
    invaders,
    playerBolt,
    invaderBolts,
    explosions,
    score,
  };
}

export function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case "tick":
      return tickGame(state);
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Presentation model — a plain character/kind grid, decoupled from Ink/theme
// so it can be asserted on directly in tests. init-game-view.tsx maps
// CellKind -> an actual color.
// ---------------------------------------------------------------------------

export type CellKind =
  | "empty"
  | "invader"
  | "player"
  | "playerBolt"
  | "enemyBolt"
  | "explosion";

export interface Cell {
  readonly ch: string;
  readonly kind: CellKind;
}

const INVADER_GLYPHS = ["▲", "◆", "●"] as const; // one per row, top to bottom
const PLAYER_GLYPHS = ["/", "^", "\\"] as const; // 3-wide sprite centered on playerCol
const EXPLOSION_GLYPH = "✳";

/** Render `state` into a fixed-size (height x width) grid of {ch, kind} cells. */
export function buildGrid(state: GameState): Cell[][] {
  const rows: Cell[][] = Array.from({ length: state.height }, () =>
    Array.from({ length: state.width }, () => ({
      ch: " ",
      kind: "empty" as const,
    })),
  );

  const set = (col: number, row: number, cell: Cell): void => {
    if (row >= 0 && row < state.height && col >= 0 && col < state.width) {
      rows[row]![col] = cell;
    }
  };

  for (const inv of state.invaders) {
    if (!inv.alive) continue;
    const a = absolute(state.originCol, state.originRow, inv);
    const glyph = INVADER_GLYPHS[inv.row % INVADER_GLYPHS.length]!;
    set(a.col, a.row, { ch: glyph, kind: "invader" });
  }

  const playerCol = playerColAt(state.width, state.tick);
  for (let i = 0; i < PLAYER_GLYPHS.length; i++) {
    set(playerCol - 1 + i, state.playerRow, {
      ch: PLAYER_GLYPHS[i]!,
      kind: "player",
    });
  }

  if (state.playerBolt) {
    set(state.playerBolt.col, state.playerBolt.row, {
      ch: "•",
      kind: "playerBolt",
    });
  }
  for (const b of state.invaderBolts) {
    set(b.col, b.row, { ch: "•", kind: "enemyBolt" });
  }
  for (const e of state.explosions) {
    set(e.col, e.row, { ch: EXPLOSION_GLYPH, kind: "explosion" });
  }

  return rows;
}
