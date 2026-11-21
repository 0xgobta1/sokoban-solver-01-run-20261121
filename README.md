# sokoban-solver-01-run-20261121

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/0xgobta1/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/0xgobta1/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for make.fun's "Build the best Sokoban solver, 21 November 2026" bounty. Push-based A* over box configurations (one node per push, not per step) with an admissible min-cost-matching heuristic, dead-square and frozen-block pruning, and a hallway-cut decomposition: the generator lays a one-wide hallway with rooms off it, and a box pushed into the hallway can never come back, so cutting the hallway out splits each level into independent rooms solved on their own — the level optimum is the sum of the rooms' optima. Verified on the kit's practice set: 1,000,000 on all 5 instances (push-optimal at 13/16/29/47/60 pushes), plus 3 fresh drawn sets 1,000,000 (15/15 at push-optimal), in ~0.33–0.46s per 5-instance set (budget 60s). Deterministic.

## Run it

```sh
MAKEFUN_INPUT_DIR=<input-dir> MAKEFUN_OUTPUT_DIR=<output-dir> node main.ts
```

Reads `<input-dir>/<id>/level.txt` (XSB format) and writes `<output-dir>/<id>/solution.txt` (LURD moves).

---

<sub>Entered on [make.fun](https://make.fun/?ref=jshbmycp&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
