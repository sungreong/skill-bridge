# Skill Bridge Benchmarks

Skill Bridge file operations should be improved with repeatable measurements, not only visual impressions.

## Design Reference

Skill Bridge handles local skill assets, not network transfers, but the useful lessons from FileZilla-style transfer tools still apply:

- Use a queue-like transfer plan instead of copying hidden side effects immediately.
- Collapse parent/child selections so a folder and its children are not copied twice.
- Use bounded concurrency for independent file copies and directory scans.
- Keep destructive operations explicit and reviewable.
- Measure both speed and correctness because a fast scan that misses files is worse than a slow one.

Current implementation choices:

- Folder copy uses bounded parallel recursive copy instead of shell-specific commands.
- VS Code tree scans delegate to the shared core `collectFiles` helper with a containment root, so symlink safety and traversal behavior stay in one implementation.
- Skill root scans go directly into each agent's `skills` directory and use bounded multi-root parallelism because Windows measurements showed unbounded disk contention.
- Refresh logs include stage timing so real VS Code usage can be compared with benchmark fixtures.
- Local benchmark outputs are ignored by Git; CI artifacts are the preferred place for OS-specific results.

## Current Milestone

The current concrete target is to make Skill Bridge file movement and loading measurable, shared, and package-safe across the supported VS Code extension matrix.

Completion criteria:

- VS Code scans use the shared core file traversal helper instead of carrying a separate walker.
- File collection, folder copy, transfer apply, and transfer-plan generation keep conservative speedup gates against serial controls.
- Broader loading scans such as `vscode.scanAgentRoots` remain observation-only until real refresh logs prove a stable win.
- The packaged VSIX includes the dist-local core runtime and the generated `.vsix` is opened and checked.
- GitHub Actions builds smoke, loading, transfer, compatibility, and VSIX artifacts for ubuntu-latest, macos-latest, and windows-latest on Node 20 and 24.

Architecture observations from similar tools:

- File transfer tools usually separate planning, queuing, applying, and reporting. Skill Bridge follows that shape with transfer plans, reviewable diffs, bounded apply queues, and generated benchmark/status reports.
- VS Code extensions should keep extension-host work predictable. Skill Bridge avoids shell copy commands, avoids synchronous filesystem APIs in extension code, and coalesces refresh requests so watcher bursts do not start overlapping tree scans.
- Asset managers should preserve folder identity instead of flattening files. Skill Bridge copies complete `skills/<skill-name>` folders and verifies `SKILL.md`, which keeps references, scripts, and assets together.
- Cross-platform tools should prove behavior on path edge cases. The smoke tests cover spaces, Unicode/Korean paths, traversal rejection, copy correctness, and symlink escape checks where the OS allows them.
- Loading performance should be observed separately from transfer performance. The smoke preset catches quick regressions; the loading preset tracks multi-agent startup-style scans and the transfer preset remains available for larger copy and transfer-plan investigations.

Known performance signals to keep watching:

- `vscode.scanAgentRoots` is compared against `control.serialScanManagedSkillRoots`, which scans only managed `skills` roots sequentially. The older full-root serial scan remains listed as a diagnostic signal for noisy agent folders.
- `core.copyDirectory` and single-root `vscode.collectFiles` should generally stay faster than serial controls.
- Watch for regressions in `scan` and `groupsChrome` from real `[Refresh:timing]` output before optimizing blindly.

## File Operation Smoke Test

Run the default local performance/compatibility check:

```bash
npm run check:performance
```

It verifies the file operation GitHub Actions workflow coverage, checks the artifact comparers, checks the VS Code Performance Tools wiring, verifies the non-destructive artifact preparation helper, verifies performance-status local/CI behavior, checks the command manifest, builds once, runs the cross-platform file operation smoke test, writes a smoke benchmark summary to `.benchmarks/performance-check-summary.md`, writes a loading-style benchmark summary to `.benchmarks/performance-loading-summary.md`, and writes a transfer-focused benchmark summary to `.benchmarks/performance-transfer-summary.md`.
The local check also requires conservative speedups for file collection, folder copy, transfer apply, and transfer-plan generation operations that should consistently beat their serial controls. The transfer preset uses a larger fixture to exercise bulk copy, queued apply, and transfer-plan generation more directly.
VSIX packaging also checks the built artifact itself: `check:vsix-runtime-deps` opens the generated `.vsix` and verifies that the dist-local core runtime used by the VS Code extension is actually included.

From the VS Code extension, run `Skill Bridge: Open Performance Tools` or use the Skill Bridge global tools menu. The command can open this guide, run `npm run check:performance` in a terminal when the current workspace has that script, open `.benchmarks/performance-status.md`, or copy the local check, benchmark, refresh timing, artifact comparison, and performance status commands.

Generate a compact requirement/evidence status report:

```bash
npm run report:performance-status -- --summary .benchmarks/performance-status.md
```

The report separates local evidence from remote CI evidence. Local checks can verify workflow wiring and artifact comparison behavior; hosted macOS/Linux/Windows proof still requires a GitHub Actions run. When `.benchmarks/performance-check.json` or `.benchmarks/performance-loading.json` exists, the report also includes local serial-control speedup tables so the current smoke and loading improvement numbers are visible in one place. Gated operations show their minimum speedup and `pass`; observation-only operations such as `vscode.scanAgentRoots` show `observe`.
The report also includes an Architecture Readout that compares the current shape to file-transfer and asset-manager tools: plan/queue/apply/report separation, shared core file operations, bounded extension-host loading work, cross-OS path safety, and selective performance gates.
The same report includes an external CI evidence checklist that lists every OS/Node artifact expected from the GitHub Actions matrix, including the Windows symlink exception.
In GitHub Actions, the comparison job generates the same status report after smoke/loading/transfer benchmark, smoke compatibility, and VSIX artifacts have been compared, appends it to the job summary, and uploads it in the `file-ops-comparison` artifact.

Run this after changing path handling, scan logic, or copy logic:

```bash
npm run test:file-ops
```

It builds the project, creates a temporary workspace with spaces in the path, and verifies:

- VS Code skill file collection
- core skill file collection
- transfer scope collection
- folder copy behavior
- workspace-style path resolution
- absolute path and `..` traversal rejection
- symlink escape rejection when the current OS/user permissions allow symlink creation
- spaces and Korean/Unicode path segments

On GitHub Actions, every OS/Node matrix entry writes a `smoke-file-ops-<os>-node<version>.json` artifact. Linux and macOS also run the same smoke test again with `--require-symlink-check` and upload `smoke-file-ops-symlink-<os>-node<version>.json`. Windows keeps symlink creation optional because local policy and developer-mode settings can prevent unprivileged directory symlinks.

## File Operation Benchmark

Run the default benchmark:

```bash
npm run benchmark:file-ops
```

Use a standard preset:

```bash
npm run benchmark:file-ops -- --preset smoke
npm run benchmark:file-ops -- --preset loading --include-control
npm run benchmark:file-ops -- --preset transfer --include-control
```

Presets:

- `smoke`: quick CI-sized check
- `loading`: multi-agent loading-style scan
- `transfer`: larger copy/scan fixture

The fixture also creates ignored non-skill files under each agent root. This keeps the benchmark closer to real `.codex`, `.cursor`, and `.agents` folders, where cache/config files can live next to `skills`.

Create a baseline file:

```bash
npm run benchmark:file-ops -- --preset transfer --write .benchmarks/file-ops-win32.json
```

Compare a later run against that baseline:

```bash
npm run benchmark:file-ops -- --preset transfer --compare .benchmarks/file-ops-win32.json
```

Write a Markdown summary table:

```bash
npm run benchmark:file-ops -- --skills 48 --files 32 --rounds 5 --summary .benchmarks/file-ops-summary.md
```

Tune fixture shape when investigating a specific workspace:

```bash
npm run benchmark:file-ops -- --skills 48 --files 32 --depth 2 --agents 6 --noise-files 64
```

Compare against simple serial control operations:

```bash
npm run benchmark:file-ops -- --skills 48 --files 32 --rounds 5 --include-control
```

When `--include-control` is set, the JSON and Markdown summary include speedup ratios such as `core.copyDirectory` versus `control.serialCopyDirectory`.

Fail when selected operations do not beat their serial controls by enough:

```bash
npm run benchmark:file-ops -- --skills 48 --files 32 --rounds 5 --include-control --fail-on-min-speedup core.copyDirectory=1.2,vscode.collectFiles=2
```

Fail when any operation regresses beyond a median threshold:

```bash
npm run benchmark:file-ops -- --skills 48 --files 32 --rounds 5 --compare .benchmarks/file-ops-win32.json --fail-on-median-regression 25
```

Use the same preset, or the same `--skills`, `--files`, `--depth`, `--agents`, `--noise-files`, and `--rounds` values when comparing runs.

## Reading Results

The benchmark reports both average and median timings. Median is usually better for judging local file operations because Windows Defender, Spotlight, antivirus tools, and filesystem cache state can create outliers.

The benchmark also validates operation results. A run fails if a scan or copy reports the wrong file count, even when the timing numbers look good.

Tracked operations:

- `vscode.collectFiles`: extension-side scan for skill roots
- `core.collectFiles`: shared core scan used by promote/import-style logic
- `vscode.collectScopeEntries`: transfer manager scope expansion
- `core.copyDirectory`: shared folder copy
- `vscode.applyTransferQueueCore`: multi-skill transfer-apply queue using bounded folder copy
- `vscode.scanAgentRoots`: loading-style scan across multiple workspace agent roots
- `vscode.transferPlanCore`: transfer-plan core cost for source/target scope collection plus same-size content comparison
- `control.serialCollectFiles`: optional sequential scan baseline when `--include-control` is set
- `control.serialCopyDirectory`: optional sequential copy baseline when `--include-control` is set
- `control.serialApplyTransferQueue`: optional sequential multi-skill transfer-apply baseline when `--include-control` is set
- `control.serialScanManagedSkillRoots`: optional sequential multi-agent scan baseline when `--include-control` is set. This scans only each agent's managed `skills` directory, so it is the fair serial control for `vscode.scanAgentRoots`.
- `control.serialScanAgentRoots`: optional full-root diagnostic scan when `--include-control` is set. This scans the full agent root and then filters to `skills/**`, so it shows the cost of not jumping directly into the managed skill directory.
- `control.serialTransferPlan`: optional sequential transfer-plan baseline when `--include-control` is set. This collects source and target scopes sequentially and compares same-size file contents one by one.

Negative change percentages are faster than the baseline. Positive values are slower and should be inspected before accepting a performance change.

Use `--fail-on-median-regression` for local release checks or dedicated performance jobs. Avoid strict regression gates on shared CI runners unless the baseline was produced on the same OS, Node version, and runner class.

## Refresh Timing Logs

The extension writes stage timings to the Skill Bridge output channel:

```text
[Refresh:timing] scan=12ms inventory+meta=8ms providers+diagnostics=3ms groups+chrome=5ms watchers=0ms
[Refresh:scan] workspaceSkills=8ms/20 centralSkills=5ms/14 workspaceInstructions=1ms/2 centralInstructions=1ms/1 agents=4
```

Copy output logs into a file and summarize them:

```bash
npm run summarize:refresh-timings -- --input .benchmarks/refresh.log --summary .benchmarks/refresh-summary.md
```

Create and compare a refresh timing baseline:

```bash
npm run summarize:refresh-timings -- --input .benchmarks/refresh.log --write .benchmarks/refresh-baseline.json
npm run summarize:refresh-timings -- --input .benchmarks/refresh-new.log --compare .benchmarks/refresh-baseline.json --fail-on-median-regression 25
```

The summary reports median, average, p90, and max timings for:

- `scan`
- `inventoryMeta`
- `providersDiagnostics`
- `groupsChrome`
- `watchers`
- `total`

When `[Refresh:scan]` lines are present, the summary also reports the scan breakdown for `workspaceSkills`, `centralSkills`, `workspaceInstructions`, and `centralInstructions`, including median item counts. This is the first place to look when the side tree feels slow but fixture benchmarks still pass.

The refresh timing parser has its own regression check:

```bash
npm run check:refresh-timings
```

## Cross-OS Notes

The scripts use Node APIs only, not shell-specific copy commands, so the same commands should run on Windows, macOS, and Linux. Keep generated baselines per OS and Node version, for example:

- `.benchmarks/file-ops-win32-node20.json`
- `.benchmarks/file-ops-win32-node24.json`
- `.benchmarks/file-ops-darwin-node20.json`
- `.benchmarks/file-ops-darwin-node24.json`
- `.benchmarks/file-ops-linux-node20.json`
- `.benchmarks/file-ops-linux-node24.json`

Local `.benchmarks` outputs are ignored by Git. Keep long-lived baselines as CI artifacts or intentionally copy selected results into documentation when needed.

The `File Operations` GitHub Actions workflow runs the smoke test and a small benchmark on:

- `ubuntu-latest`
- `macos-latest`
- `windows-latest`

Each OS runs on Node 20 and Node 24. Each run includes serial control timings, enforces conservative speedup gates for the operations that should consistently beat their serial controls, and uploads a benchmark JSON artifact named with both the OS and Node version. The benchmark command also writes the matrix OS and Node major into the JSON itself so comparison does not depend only on the file name. Artifact upload fails if the JSON file is missing, and artifacts are retained for 14 days. Use those artifacts as OS-specific and runtime-specific reference points instead of comparing Windows-local numbers against macOS or Linux numbers.
Each matrix entry also runs the Performance Tools wiring guard, the performance-status behavior guard, and the refresh timing parser guard before the smoke and benchmark steps, so extension command drift, status-report CI/local behavior regressions, and refresh log parser regressions are caught on every OS/Node runner.

The workflow also uploads `smoke-file-ops-*` artifacts from the cross-platform smoke tests. Those are the compatibility evidence for path traversal rejection, Unicode paths, spaces in paths, copy correctness, and symlink escape behavior; the `file-ops-*`, `loading-file-ops-*`, and `transfer-file-ops-*` benchmark artifacts remain reserved for timing comparison.

After downloading smoke artifacts, verify the compatibility matrix:

```bash
npm run compare:smoke-file-ops-artifacts -- --dir .benchmarks/smoke-artifacts --summary .benchmarks/smoke-file-ops-artifacts.md --require-matrix
```

The smoke comparer requires base smoke artifacts for Windows, macOS, and Linux on Node 20 and 24. It also requires symlink smoke artifacts for macOS and Linux on both Node versions.

On GitHub Actions, the matrix job appends per-run benchmark tables to the job summary. A follow-up `compare-file-ops` job downloads benchmark, smoke, loading, transfer, and VSIX artifacts, runs every artifact comparer with `--require-matrix`, generates `performance-status.md`, appends every summary to the job summary, and uploads them as `file-ops-comparison`.

The local `npm run check:file-ops-workflow` guard verifies that this workflow still covers the OS matrix, Node 20/24 matrix, serial-control benchmark output, benchmark artifact upload, missing-artifact failure, refresh timing parser coverage, the workflow's own coverage-guard step, and the aggregate comparison job.

Prepare isolated artifact folders before downloading GitHub Actions artifacts:

```bash
npm run prepare:performance-artifacts -- --out-dir .benchmarks
```

Then download artifacts into `.benchmarks/artifacts`, `.benchmarks/loading-artifacts`, `.benchmarks/transfer-artifacts`, `.benchmarks/smoke-artifacts`, and `.benchmarks/vsix-artifacts`, and compare the OS/Node matrix:

```bash
npm run compare:file-ops-artifacts -- --dir .benchmarks/artifacts --summary .benchmarks/file-ops-artifacts.md --require-matrix --require-preset smoke
npm run compare:loading-file-ops-artifacts -- --dir .benchmarks/loading-artifacts --summary .benchmarks/loading-file-ops-artifacts.md --require-matrix --require-preset loading
npm run compare:transfer-file-ops-artifacts -- --dir .benchmarks/transfer-artifacts --summary .benchmarks/transfer-file-ops-artifacts.md --require-matrix --require-preset transfer
npm run compare:vsix-artifacts -- --dir .benchmarks/vsix-artifacts --summary .benchmarks/vsix-artifacts.md --require-matrix
```

Or verify all downloaded performance artifacts and regenerate the final status report in one command:

```bash
npm run verify:performance-artifacts -- --benchmark-dir .benchmarks/artifacts --loading-dir .benchmarks/loading-artifacts --transfer-dir .benchmarks/transfer-artifacts --smoke-dir .benchmarks/smoke-artifacts --vsix-dir .benchmarks/vsix-artifacts --out-dir .benchmarks
```

Use `--benchmark-dir`, `--loading-dir`, `--transfer-dir`, `--smoke-dir`, `--vsix-dir`, and `--out-dir` when artifacts are downloaded to custom folders.

Without `--require-matrix`, the commands still print Markdown comparison tables but do not fail on missing OS/Node artifacts.
The comparer searches recursively, so it works whether artifacts are downloaded flat or into one folder per artifact. It fails when a benchmark artifact reports `ok: false`, correctness failures, speedup failures, missing required speedup gates, speedup values below required gates, median regressions, empty results, duplicate OS/Node artifacts, or a preset that does not match `--require-preset`.
Keep downloaded CI artifacts in isolated folders such as `.benchmarks/artifacts`, `.benchmarks/loading-artifacts`, `.benchmarks/transfer-artifacts`, `.benchmarks/smoke-artifacts`, and `.benchmarks/vsix-artifacts`. Running the comparer against a broad local `.benchmarks` folder can intentionally fail if older local JSON files are still present.
