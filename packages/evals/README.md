# browsemode-evals

Eval suite for browsemode. Real-world browser tasks scored against obscura, Chrome, or both.

The package is private (not published) and run with `bun run evals` from anywhere in the workspace.

## Layout

```
packages/evals/
├── src/
│   ├── cli.ts              Commander entry: list / run / runners / benchmarks
│   ├── orchestrator.ts     Open browser, dispatch to runner, capture artifact
│   ├── runner.ts           Runner interface + registry
│   ├── runners/
│   │   ├── direct-sdk.ts   No LLM. YAML carries an inline `script`.
│   │   ├── pi.ts           Spawns pi rpc with only pi-browsemode loaded.
│   │   └── lib/
│   │       ├── pi-rpc-client.ts   JSONL stdio client over child_process
│   │       └── pi-spawn.ts        Shared pi argv + system prompt + helpers
│   ├── judge.ts            SubstringJudge (deterministic) + getJudge registry
│   ├── judges/
│   │   └── pi.ts           Spawns pi rpc with the judge extension; tool-call args ARE the score
│   ├── benchmarks/
│   │   ├── base.ts         Benchmark interface + registry + sample/limit helpers
│   │   ├── webvoyager.ts   643 tasks; auto-fetches from MinorJerry/WebVoyager
│   │   └── mind2web.ts     2.3k tasks; needs --data-path (HF-gated)
│   ├── loader.ts           Load every YAML in tasks/
│   ├── types.ts            EvalTask / RunArtifact / Score / Report
│   └── index.ts            Public barrel
├── extensions/
│   └── judge/
│       └── index.ts        pi extension: registers the `judge` tool
└── tasks/
    ├── static/             example-com, hn-top, wikipedia-search
    ├── spa/                todomvc-add
    └── chrome-only/        dialog-confirm, layout-occluded-click  (only: [chrome])
```

## Task YAML

```yaml
name: hn-top-titles            # optional, defaults to filename
task: Open Hacker News and ... # plain-English instruction
url: https://news.ycombinator.com
tags: [scrape, list]
budget:
  maxSteps: 4
  timeoutSec: 60
only: [chrome]                  # optional backend gate
script: |                       # optional, only used by direct-sdk runner
  await page.scan();
  return await page.list();
judge:
  must:
    - "hacker news"             # case-insensitive substring match
  must_not:
    - "captcha"
```

## Running

```bash
# from the workspace root
bun run --filter browsemode-evals evals -- list                                # YAML tasks on disk
bun run --filter browsemode-evals evals -- benchmarks                          # external benchmarks
bun run --filter browsemode-evals evals -- run                                 # all YAML on chrome
bun run --filter browsemode-evals evals -- run --backend both                  # obscura + chrome
bun run --filter browsemode-evals evals -- run hn                              # filter YAML by name/tag
bun run --filter browsemode-evals evals -- run --benchmark webvoyager -l 10    # 10 WebVoyager tasks
bun run --filter browsemode-evals evals -- run --benchmark webvoyager -s 50 -l 5
bun run --filter browsemode-evals evals -- run --benchmark webvoyager -f web_name=GitHub
bun run --filter browsemode-evals evals -- run --benchmark mind2web --data-path ./mind2web.json -l 3
bun run --filter browsemode-evals evals -- run --json                          # CI-friendly Report
```

The default runner is `direct-sdk`. It needs no API key. It runs the YAML's `script` field via `Browser.exec` and feeds the return value to the judge. This is the smoke test, not a real eval. Benchmark tasks have no `script`, so running them through `direct-sdk` errors out (by design).

The real eval runner is `pi`. It spawns pi (`@mariozechner/pi-coding-agent`) in `--mode rpc` loaded with **only** the `pi-browsemode` extension (no global skills/extensions/prompts/context-files), sends the task as a single user prompt, and captures pi's final assistant message as the run artifact. Use `--runner pi` to enable.

The LLM judge follows the same pattern under id `pi`. It spawns pi loaded with **only** the local `extensions/judge/` extension that registers a single `judge` tool with a strict TypeBox schema. The model calls the tool exactly once with `{score, rationale, met_must, failed_must, hit_must_not}`; the judge runner reads the tool-call args off the event stream and returns them as the `Score`. No JSON parsing, no "the model returned almost-but-not-quite valid JSON" failures. Use `--judge pi` to enable.

**Auth**: pi reads `~/.pi/agent/auth.json` for credentials. If you've already run `pi` and `/login`'d to Anthropic Claude Pro/Max, OAuth tokens auto-refresh and Just Work. Both runner and judge inject the `"You are Claude Code, Anthropic's official CLI for Claude."` line via `--append-system-prompt` because Claude Pro OAuth requires it (normally provided by your global `~/.pi/agent/AGENTS.md`, but we strip context files for hermeticity).

**Configuration via env**:

| Variable | Default | Meaning |
|---|---|---|
| `PI_BIN` | `pi` | Pi binary to spawn |
| `PI_PROVIDER` | `anthropic` | LLM provider |
| `PI_MODEL` | `claude-sonnet-4-20250514` | Model id |
| `PI_THINKING` | (unset) | `off` / `low` / `medium` / `high` / `xhigh` |
| `PI_BROWSEMODE_EXT_PATH` | (auto) | Override the runner's extension dir (default: `packages/pi-browsemode/.pi/extensions/browsemode`) |
| `PI_JUDGE_EXT_PATH` | (auto) | Override the judge's extension dir (default: `packages/evals/extensions/judge`) |
| `PI_JUDGE_THINKING` | `off` | Thinking level just for the judge subprocess |
| `PI_BROWSE_BACKEND` | `chrome` | Browser backend for pi-browsemode: `chrome` or `obscura` |
| `PI_BROWSE_OBSCURA_PORT` | `9333` | Where the runner's extension expects obscura when `PI_BROWSE_BACKEND=obscura` |
| `BROWSEMODE_EVALS_PI_LOG` | (unset) | If set, dump pi's full event stream as JSONL per task for replay |

## External benchmarks

Two are wired up. Both produce `EvalTask` items the orchestrator runs the same way as YAML tasks. Both apply `--limit`, `--sample` (seeded for reproducibility), and `--filter-kv key=value` (repeatable).

**WebVoyager** (`--benchmark webvoyager`). 643 real-world tasks across 15 popular sites (Allrecipes, Amazon, Apple, ArXiv, BBC News, Booking, Cambridge Dictionary, Coursera, ESPN, GitHub, Google Flights/Map/Search, Huggingface, Wolfram Alpha). Source: [MinorJerry/WebVoyager](https://github.com/MinorJerry/WebVoyager). The first call fetches the JSONL and caches it at `~/.cache/browsemode-evals/webvoyager/WebVoyager_data.jsonl`; subsequent runs are offline. Filter keys: `web_name`, `id`.

**Mind2Web** (`--benchmark mind2web`). 2,350 web tasks across 137 websites. Source: [OSU-NLP-Group/Mind2Web](https://github.com/OSU-NLP-Group/Mind2Web). The dataset is HuggingFace-gated (you have to accept usage terms), so we don't auto-download. Pass `--data-path /path/to/processed.json` or place a copy at `~/.cache/browsemode-evals/mind2web/processed.json`. browser-use ships a compatible preprocessed copy at `tests/mind2web_data/processed.json`. Mind2Web tasks intentionally lack a starting URL; we do best-effort website-name -> URL mapping for the most common sites and fall back to a Google search otherwise. Filter keys: `website`, `domain`, `subdomain`.

Both benchmarks have open-ended success criteria, so the substring judge under-grades them. The `Report.runs[].artifact.output` is what matters for replay until the LLM judge can score against generated trajectories. The original WebVoyager paper used GPT-4V-as-judge; the original Mind2Web paper scored per-step element-match accuracy. Reproducing either is on the roadmap once the LLM judge lands.

## Backends

| Backend | What runs |
|---|---|
| `obscura` | Connects to a CDP server at `--obscura-host:--obscura-port` (default `localhost:9333`). You start obscura yourself: `obscura serve --port 9333 --stealth`. |
| `chrome`  | `Browsemode.launch()` spawns the managed Chrome via the standard finder (Chrome / Chromium / Brave / Edge / Arc). |
| `both`    | Each task runs once per backend. Tasks with `only: [chrome]` skip obscura, and vice-versa. |

The `Report` JSON breaks down pass/fail per backend. Chrome is the production/default signal; obscura coverage is tracked separately as the lightweight/static subset.

## Status

- ✅ Package skeleton, runner registry, orchestrator, CLI
- ✅ Substring judge (deterministic, no LLM)
- ✅ Six sample tasks across static / SPA / chrome-only
- ✅ Benchmark scaffolding (Benchmark interface + registry + sample/limit/filter)
- ✅ WebVoyager adapter (auto-fetch + cache)
- ✅ Mind2Web adapter (HF-gated, requires --data-path)
- ✅ `pi` runner (spawns pi rpc, only pi-browsemode loaded, Anthropic OAuth via auth.json)
- ✅ `pi` judge (spawns pi rpc, only local judge extension loaded, single `judge` tool with strict schema, no JSON parsing)
- ⬜ Benchmark-specific scoring (WebVoyager GPT-4V judge, Mind2Web per-step element match)
