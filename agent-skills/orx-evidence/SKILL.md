---
name: orx-evidence
description: "Analyze and cite experiment evidence: read `orx logs`, design logged metrics, and format clickable file, run, and artifact references plus experiment summaries. Use after a run finishes, before making factual or quantitative claims, when mentioning project files or artifacts, or when reporting experiment progress."
---

Run logs are the evidence channel. Make the run command print everything needed
to judge the result, then read it back with `orx logs`.

## Reading run logs — `orx logs`

A run's terminal output is captured live while it runs and persisted afterwards.

```sh
orx logs <runId>                    # tail (the end — usually what you want)
orx logs <runId> --head             # read from the start instead
orx logs <runId> --bytes 200000     # raise the byte cap (default 64 KB, max 1 MB)
orx logs <runId> --range 4096:8192  # exact byte window [start, end)
```

- The log goes to **stdout**; a `[source] bytes a–b of N` status line goes to
  **stderr**, noting if content was truncated above or below.
- `<runId>` comes from `orx runs <projectId>`.

## Make the run print its own evidence

Print everything needed to stdout: final metrics, a compact summary, and the key
configuration. If a run's result is not in its log, it cannot be inspected later.

- Print final metrics and a compact summary block at the end of the run, not just
  scattered during training.
- Echo the configuration the run actually used so the log identifies the variant.
- For a long run, print periodic one-line metrics so its trajectory remains
  visible through byte-range reads.

## Cite evidence in chat

Use `$...$` for inline math and `$$...$$` for display math. Escape literal
currency signs, for example `\$10`.

Every substantive factual or quantitative claim needs a clickable evidence tag
immediately after it. Emit tags as raw text, never inside backticks or fences:

- File or code facts: use `<file path="relative/path.py" />`, with optional
  `lines="20-40"`. Use repository-relative paths. For a file on an experiment
  branch, add `exp="<experimentId>"` to open the committed version.
- Metrics or results: use `<run id="<runId>" />`, optionally with a concise
  `label="+3.65pp"`. Run ids come from `orx runs` and the cited run's logs must
  support the claim.
- Artifacts: use `<file path="artifacts/<relative-path>" />`.

Every file or artifact mentioned in prose must use a file tag, not a bare or
backticked path. Paths inside commands and code blocks are exempt.

Wrong: Saved as `figures/result.png`.
Right: Saved as <file path="artifacts/figures/result.png" />.
