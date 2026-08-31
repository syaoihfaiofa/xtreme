# PC Tool performance acceptance

Run without credentials to execute cache-policy unit tests only:

```bash
python3 scripts/perf_pc_tool.py
```

For formal acceptance, provide an external scene with at least 500 frames and preview assets:

```bash
export XTREME1_PERF_BASE_URL=http://localhost:8190
export XTREME1_PERF_USERNAME='user@example.com'
export XTREME1_PERF_PASSWORD='password'
export XTREME1_PERF_DATASET_ID=3
export XTREME1_PERF_SCENE_ID=570
python3 scripts/perf_pc_tool.py
```

Use `--smoke` for a smaller local scene. Reports are written to `artifacts/performance/` and are not tracked by Git.
