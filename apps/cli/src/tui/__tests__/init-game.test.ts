/**
 * Unit tests for the space-invaders simulation that plays during `oxagen
 * init` (see init-game.ts). Most transition tests construct an exact
 * GameState by hand and assert the exact output of a single tickGame() call
 * — the reducer has no hidden internals, so this is more precise (and far
 * less fragile to constant tuning) than simulating from tick 0 and counting
 * ticks until something happens. Formation-march/reset behavior that
 * genuinely depends on many ticks is covered as a property ("eventually
 * true"), matching renderInvadersLane's own test style in
 * repl/__tests__/components.test.tsx.
 */
import { describe, it, expect } from "vitest";
import {
  createInitialGameState,
  gameReducer,
  tickGame,
  playerColAt,
  moveInterval,
  absolute,
  buildGrid,
  type GameState,
  type Invader,
} from "../init-game.js";

describe("createInitialGameState", () => {
  it("clamps width into [26, 44]", () => {
    expect(createInitialGameState(10).width).toBe(26);
    expect(createInitialGameState(1000).width).toBe(44);
    expect(createInitialGameState(30).width).toBe(30);
  });

  it("defaults to a sane width when none is given", () => {
    const s = createInitialGameState();
    expect(s.width).toBeGreaterThanOrEqual(26);
    expect(s.width).toBeLessThanOrEqual(44);
  });

  it("starts with a full formation, all alive", () => {
    const s = createInitialGameState(34);
    expect(s.invaders.length).toBe(18); // 3 rows x 6 cols
    expect(s.invaders.every((i) => i.alive)).toBe(true);
  });

  it("starts with no bolts, no explosions, score 0, wave 1, tick 0", () => {
    const s = createInitialGameState(34);
    expect(s.playerBolt).toBeNull();
    expect(s.invaderBolts).toEqual([]);
    expect(s.explosions).toEqual([]);
    expect(s.score).toBe(0);
    expect(s.wave).toBe(1);
    expect(s.tick).toBe(0);
    expect(s.dir).toBe(1);
  });

  it("centers the formation within the playfield width", () => {
    const s = createInitialGameState(34);
    const cols = s.invaders.map((i) => i.col);
    const span = Math.max(...cols) - Math.min(...cols) + 1;
    expect(s.originCol).toBeGreaterThanOrEqual(0);
    expect(s.originCol + span).toBeLessThanOrEqual(s.width);
  });

  it("places the player row at the bottom of the playfield", () => {
    const s = createInitialGameState(34);
    expect(s.playerRow).toBe(s.height - 1);
  });
});

describe("determinism", () => {
  it("replaying the same tick sequence from the same start always matches", () => {
    const run = (): GameState => {
      let s = createInitialGameState(34);
      for (let i = 0; i < 60; i++) s = tickGame(s);
      return s;
    };
    expect(run()).toEqual(run());
  });

  it("gameReducer(tick) matches tickGame directly", () => {
    const s = createInitialGameState(34);
    expect(gameReducer(s, { type: "tick" })).toEqual(tickGame(s));
  });

  it("ignores unrecognized actions and returns state unchanged", () => {
    const s = createInitialGameState(34);
    // Defensive default branch — exercised via a deliberately invalid action.
    const result = gameReducer(s, { type: "unknown" } as unknown as {
      type: "tick";
    });
    expect(result).toBe(s);
  });

  it("advances tick by exactly 1 per call", () => {
    let s = createInitialGameState(34);
    for (let i = 1; i <= 5; i++) {
      s = tickGame(s);
      expect(s.tick).toBe(i);
    }
  });
});

describe("formation march", () => {
  it("eventually moves both directions and descends at least one row", () => {
    let s = createInitialGameState(30);
    const dirsSeen = new Set<number>();
    for (let i = 0; i < 150; i++) {
      s = tickGame(s);
      dirsSeen.add(s.dir);
    }
    expect(dirsSeen.has(1)).toBe(true);
    expect(dirsSeen.has(-1)).toBe(true);
    expect(s.originRow).toBeGreaterThan(0);
  });

  it("does not move the formation on a non-move tick", () => {
    const base = createInitialGameState(30);
    // interval is 6 while the full wave is alive (see moveInterval); tick 1 is not a multiple of it.
    const s = tickGame({ ...base, tick: 0 });
    expect(s.originCol).toBe(base.originCol);
    expect(s.originRow).toBe(base.originRow);
  });
});

describe("moveInterval", () => {
  it("is 6 ticks/step with a full wave (0 destroyed)", () => {
    expect(moveInterval(18, 18)).toBe(6);
  });

  it("speeds up as more invaders are destroyed", () => {
    expect(moveInterval(12, 18)).toBe(5); // 6 destroyed -> -1
    expect(moveInterval(6, 18)).toBe(4); // 12 destroyed -> -2
  });

  it("never drops below the 2-tick floor", () => {
    expect(moveInterval(0, 24)).toBe(2); // 24 destroyed -> -4, floored at 2
    expect(moveInterval(1, 100)).toBe(2); // 99 destroyed -> way past the floor
  });
});

describe("absolute", () => {
  it("offsets an invader's formation-relative position by the origin", () => {
    const inv: Invader = { id: "0-0", col: 2, row: 1, alive: true };
    expect(absolute(5, 3, inv)).toEqual({ col: 7, row: 4 });
  });
});

describe("playerColAt", () => {
  it("stays within the playfield for every tick over a full period", () => {
    const width = 34;
    for (let t = 0; t < 400; t++) {
      const col = playerColAt(width, t);
      expect(col).toBeGreaterThanOrEqual(0);
      expect(col).toBeLessThan(width);
    }
  });

  it("is periodic", () => {
    const width = 34;
    // period = 2 * floor(width * 0.6)
    const period = 2 * Math.floor(width * 0.6);
    for (const t of [0, 1, 7, 20]) {
      expect(playerColAt(width, t)).toBe(playerColAt(width, t + period));
    }
  });

  it("is deterministic: same (width, tick) always returns the same column", () => {
    expect(playerColAt(34, 17)).toBe(playerColAt(34, 17));
  });
});

describe("player bolt", () => {
  function baseState(overrides: Partial<GameState> = {}): GameState {
    const s = createInitialGameState(30);
    return { ...s, tick: 0, ...overrides };
  }

  it("fires a fresh bolt on the cadence when none is active", () => {
    // tick becomes 5 (PLAYER_FIRE_INTERVAL) after this call.
    const s = baseState({ tick: 4, playerBolt: null });
    const result = tickGame(s);
    expect(result.playerBolt).not.toBeNull();
    expect(result.playerBolt?.row).toBe(result.playerRow - 1);
    expect(result.playerBolt?.col).toBe(playerColAt(s.width, 5));
  });

  it("does not fire off the cadence", () => {
    const s = baseState({ tick: 0, playerBolt: null }); // -> tick 1, not a multiple of 5
    const result = tickGame(s);
    expect(result.playerBolt).toBeNull();
  });

  it("moves an in-flight bolt up by one row when nothing is in its path", () => {
    const invaders: Invader[] = [{ id: "0-0", col: 0, row: 0, alive: true }];
    const s = baseState({
      tick: 0,
      originCol: 10,
      originRow: 0,
      invaders,
      playerBolt: { col: 5, row: 5 }, // column 5 never matches the invader at absolute col 10
    });
    const result = tickGame(s);
    expect(result.playerBolt).toEqual({ col: 5, row: 4 });
    expect(result.score).toBe(s.score);
    expect(result.explosions).toEqual([]);
  });

  it("clears the bolt without a hit when it passes the top row", () => {
    const invaders: Invader[] = [{ id: "0-0", col: 0, row: 5, alive: true }];
    const s = baseState({
      tick: 0,
      originCol: 10,
      originRow: 0,
      invaders,
      playerBolt: { col: 5, row: 0 },
    });
    const result = tickGame(s);
    expect(result.playerBolt).toBeNull();
    expect(result.score).toBe(s.score);
  });

  it("kills the invader it reaches: clears the bolt, scores, and spawns an explosion", () => {
    const invaders: Invader[] = [{ id: "0-0", col: 0, row: 0, alive: true }];
    const s = baseState({
      tick: 0, // -> tick 1, not a move tick (interval 6) or fire tick (interval 7) for invaders
      originCol: 10,
      originRow: 0,
      invaders,
      playerBolt: { col: 10, row: 1 }, // one row below the invader at absolute (10, 0)
    });
    const result = tickGame(s);

    expect(result.playerBolt).toBeNull();
    expect(result.score).toBe(s.score + 10);
    expect(result.invaders[0]?.alive).toBe(false);
    expect(result.explosions).toContainEqual({ col: 10, row: 0, ttl: 2 });
  });

  it("never lets a dead invader be hit again", () => {
    const invaders: Invader[] = [{ id: "0-0", col: 0, row: 0, alive: false }];
    const s = baseState({
      tick: 0,
      originCol: 10,
      originRow: 0,
      invaders: [...invaders, { id: "0-1", col: 2, row: 0, alive: true }], // keep >=1 alive so no wave reset
      playerBolt: { col: 10, row: 1 },
    });
    const result = tickGame(s);
    expect(result.score).toBe(s.score); // the dead invader at that cell scores nothing
    expect(result.playerBolt).toEqual({ col: 10, row: 0 }); // bolt just continues up
  });
});

describe("invader bolts", () => {
  function baseState(overrides: Partial<GameState> = {}): GameState {
    const s = createInitialGameState(30);
    return { ...s, tick: 0, ...overrides };
  }

  it("advances downward by one row when it does not reach the player", () => {
    const s = baseState({ invaderBolts: [{ col: 3, row: 0 }] });
    const result = tickGame(s);
    expect(result.invaderBolts).toContainEqual({ col: 3, row: 1 });
  });

  it("hits the player row at the player's column: clears and spawns an explosion", () => {
    const s0 = createInitialGameState(30);
    const tick = 1;
    const col = playerColAt(s0.width, tick);
    const s = baseState({ invaderBolts: [{ col, row: s0.playerRow - 1 }] });

    const result = tickGame(s);
    expect(
      result.invaderBolts.some((b) => b.col === col && b.row === s0.playerRow),
    ).toBe(false);
    expect(result.explosions).toContainEqual({
      col,
      row: s0.playerRow,
      ttl: 2,
    });
  });

  it("misses and clears past the player row without an explosion when columns differ", () => {
    const s0 = createInitialGameState(30);
    const tick = 1;
    const missCol = (playerColAt(s0.width, tick) + 5) % s0.width;
    const s = baseState({
      invaderBolts: [{ col: missCol, row: s0.playerRow }],
    });

    const result = tickGame(s);
    expect(result.invaderBolts).toEqual([]);
    expect(result.explosions).toEqual([]);
  });

  it("fires a new bolt on the cadence from the front-most alive invader in the cycled column", () => {
    const invaders: Invader[] = [
      { id: "back", col: 0, row: 0, alive: true },
      { id: "front", col: 0, row: 1, alive: true },
    ];
    const s = baseState({
      tick: 6, // -> tick 7 == INVADER_FIRE_INTERVAL
      originCol: 5,
      originRow: 0,
      invaders,
      invaderBolts: [],
    });
    const result = tickGame(s);
    // front-most (row 1, closer to the player) fires, one row below itself.
    expect(result.invaderBolts).toContainEqual({ col: 5, row: 2 });
  });

  it("does not fire off the cadence", () => {
    const invaders: Invader[] = [{ id: "0-0", col: 0, row: 0, alive: true }];
    const s = baseState({
      tick: 0,
      originCol: 5,
      originRow: 0,
      invaders,
      invaderBolts: [],
    });
    const result = tickGame(s); // -> tick 1, not a multiple of 7
    expect(result.invaderBolts).toEqual([]);
  });
});

describe("explosions", () => {
  it("decays ttl by 1 per tick and stays visible above 0", () => {
    const s = createInitialGameState(30);
    const withExplosion: GameState = {
      ...s,
      tick: 0,
      explosions: [{ col: 1, row: 1, ttl: 2 }],
    };
    const result = tickGame(withExplosion);
    expect(result.explosions).toContainEqual({ col: 1, row: 1, ttl: 1 });
  });

  it("clears once ttl reaches 0", () => {
    const s = createInitialGameState(30);
    const withExplosion: GameState = {
      ...s,
      tick: 0,
      explosions: [{ col: 1, row: 1, ttl: 1 }],
    };
    const result = tickGame(withExplosion);
    expect(result.explosions).toEqual([]);
  });
});

describe("wave lifecycle", () => {
  it("resets to a fresh full wave when every invader is destroyed, carrying score forward", () => {
    const s = createInitialGameState(30);
    const cleared: GameState = {
      ...s,
      tick: 10,
      score: 40,
      wave: 2,
      invaders: [{ id: "0-0", col: 0, row: 0, alive: false }],
    };
    const result = tickGame(cleared);

    expect(result.invaders.length).toBe(18);
    expect(result.invaders.every((i) => i.alive)).toBe(true);
    expect(result.wave).toBe(3);
    expect(result.score).toBe(40); // carried forward, not reset
    expect(result.originRow).toBe(0);
    expect(result.dir).toBe(1);
    expect(result.playerBolt).toBeNull();
    expect(result.invaderBolts).toEqual([]);
    expect(result.explosions).toEqual([]);
  });

  it("resets when the formation overruns the player row, without decrementing a life counter", () => {
    const s = createInitialGameState(30);
    const overrun: GameState = {
      ...s,
      tick: 0, // -> tick 1, not a move tick, so originRow below is exactly what tickGame sees
      originRow: s.playerRow,
      invaders: [{ id: "0-0", col: 0, row: 0, alive: true }],
      wave: 1,
    };
    const result = tickGame(overrun);
    expect(result.wave).toBe(2);
    expect(result.originRow).toBe(0);
    expect(result.invaders.every((i) => i.alive)).toBe(true);
  });
});

describe("buildGrid", () => {
  it("produces a height x width grid", () => {
    const s = createInitialGameState(30);
    const grid = buildGrid(s);
    expect(grid.length).toBe(s.height);
    for (const row of grid) expect(row.length).toBe(s.width);
  });

  it("places each alive invader at its absolute position with a row-based glyph", () => {
    const s = createInitialGameState(30);
    const grid = buildGrid(s);
    for (const inv of s.invaders) {
      const a = absolute(s.originCol, s.originRow, inv);
      expect(grid[a.row]?.[a.col]?.kind).toBe("invader");
    }
    // Row 0 and row 1 invaders use different glyphs.
    const row0Cell = grid[s.originRow]?.[s.originCol];
    const row1Cell = grid[s.originRow + 1]?.[s.originCol];
    expect(row0Cell?.ch).not.toBe(row1Cell?.ch);
  });

  it("does not render a dead invader", () => {
    const s = createInitialGameState(30);
    const invaders = s.invaders.map((i, idx) =>
      idx === 0 ? { ...i, alive: false } : i,
    );
    const grid = buildGrid({ ...s, invaders });
    const a = absolute(s.originCol, s.originRow, invaders[0]!);
    expect(grid[a.row]?.[a.col]?.kind).toBe("empty");
  });

  it("draws the player sprite centered on the current player column", () => {
    const s = createInitialGameState(30);
    const grid = buildGrid(s);
    const col = playerColAt(s.width, s.tick);
    expect(grid[s.playerRow]?.[col]?.kind).toBe("player");
    expect(grid[s.playerRow]?.[col - 1]?.kind).toBe("player");
    expect(grid[s.playerRow]?.[col + 1]?.kind).toBe("player");
  });

  it("draws the player bolt, invader bolts, and explosions at their cells", () => {
    const s = createInitialGameState(30);
    const withEntities: GameState = {
      ...s,
      playerBolt: { col: 2, row: 2 },
      invaderBolts: [{ col: 4, row: 4 }],
      explosions: [{ col: 6, row: 6, ttl: 1 }],
    };
    const grid = buildGrid(withEntities);
    expect(grid[2]?.[2]?.kind).toBe("playerBolt");
    expect(grid[4]?.[4]?.kind).toBe("enemyBolt");
    expect(grid[6]?.[6]?.kind).toBe("explosion");
  });
});
