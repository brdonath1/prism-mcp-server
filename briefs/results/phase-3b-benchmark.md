# Phase 3b CS-1 Adaptive-Thinking Benchmark — Results

> Generated: 2026-04-26T22:51:22.872Z
> Brief: `briefs/phase-3b-cs1-thinking-benchmark.md`
> Per-call timeout: 150000ms; maxTokens cap: 4096; model: Opus 4.7

## Verdict

**PASS**

Predicate breakdown:
- All 6 runs complete without thrown exceptions: PASS (6/6 succeeded)
- max(duration thinking-on) < 150_000ms: PASS (max=32416ms)
- max(output_tokens thinking-on) ≤ 4096: PASS (max=1665)
- extractJSON success rate (thinking-on ≥ thinking-off): PASS (on=3/3, off=3/3)

## All Runs

| Project | Condition | Duration (ms) | Input Tokens | Output Tokens | extractJSON | Strategy | Content (bytes) | Error |
|---|---|---|---|---|---|---|---|---|
| dans-bagels-platform | thinking-off | 13605 | 9266 | 712 | yes | direct | 1857 | - |
| dans-bagels-platform | thinking-on | 16894 | 9266 | 903 | yes | direct | 2206 | - |
| paypal-aaa-arbitration | thinking-off | 25296 | 41991 | 1152 | yes | direct | 3011 | - |
| paypal-aaa-arbitration | thinking-on | 22132 | 41991 | 1055 | yes | direct | 2356 | - |
| prism | thinking-off | 29632 | 108870 | 1434 | yes | direct | 3449 | - |
| prism | thinking-on | 32416 | 108870 | 1665 | yes | direct | 3194 | - |

## Aggregates

| Condition | max(duration_ms) | max(output_tokens) | extractJSON success |
|---|---|---|---|
| thinking-off | 29632 | 1434 | 3/3 |
| thinking-on  | 32416 | 1665 | 3/3 |

<!-- EOF: phase-3b-benchmark.md -->