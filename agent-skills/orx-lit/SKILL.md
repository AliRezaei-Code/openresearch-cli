---
name: orx-lit
description: "Search literature and read papers via alphaXiv, OpenAlex, and bioRxiv (`orx lit` / `orx paper`) — the preferred tool for literature search on any academic topic across CS/ML and biomed: a paper, author, blog post, or model release. Start here, not a web search: find related work, baselines, and code to seed from. Often the corpus answers outright and no web search is needed."
---

**The preferred literature tool.** For anything academic or research-related —
papers, authors, blog posts, model releases — start with `orx lit`, not a web
search: disambiguate the author or work and pull the prior art. The corpus often
answers the question outright; reach for web search only if something is
genuinely missing from it.

`orx lit --source` picks the corpus (all need **no `orx login`**; public hosts,
not the OpenResearch API):
- **`alphaxiv`** (default) — 2.5M+ arXiv papers (CS, math, physics, stats,
  q-bio/fin, EE). Full-text ranked search with a structured per-paper report.
- **`openalex`** — the OpenAlex scholarly graph (250M+ works, every discipline,
  incl. published journal articles). Ranked by relevance; hits carry citation counts.
- **`biorxiv`** — biology preprints. bioRxiv has no search API, so this searches
  OpenAlex filtered to bioRxiv's corpus; `orx paper <doi>` then fetches the
  preprint from bioRxiv itself. Use for biomed, where alphaXiv is thin.

```sh
orx lit "speculative decoding for LLMs"                   # alphaXiv (default): id, title, date, votes, abstract
orx lit "rotary position embeddings" --limit 10           # widen the result set (default 5)
orx lit "graph neural networks" --source openalex         # OpenAlex: cross-discipline, citation counts
orx lit "spike protein binding affinity" --source biorxiv # biology preprints via bioRxiv
orx lit "kv cache compression" --json                     # raw JSON (uniform LitHit shape) for piping
orx paper 2401.12345                                      # alphaXiv report (auto-detected)
orx paper 10.1101/2020.02.11.944462                       # bioRxiv preprint (auto-detected from the DOI)
orx paper 10.1038/nature14539                             # OpenAlex metadata + abstract (any other DOI / W-id)
orx paper 2401.12345v2 --full                             # alphaXiv full extracted text (fallback)
```

- **`orx lit`** prints, per hit: `<id>  <title>`, then `<date> · <metric>` (votes
  on alphaXiv, citations on OpenAlex/bioRxiv), then a truncated abstract. The
  **`id`** is what you feed to `orx paper` — an arXiv id (alphaXiv), a DOI
  (bioRxiv/OpenAlex), or an OpenAlex `W…` id. Results are relevance-ranked, capped
  at `--limit` (default 5). `--json` emits a uniform hit shape (`source`, `id`,
  `title`, `abstract`, `publicationDate`, and `votes`/`citations`/`snippets` where
  they apply) for piping.
- **`orx paper <id>`** writes to **stdout** (pipe/redirect-friendly) and
  **auto-detects the source** from the id (override with `--source`):
  arXiv id/URL → alphaXiv report; `10.1101/…` DOI → bioRxiv; any other DOI or a
  `W…` id → OpenAlex. alphaXiv returns the structured report (or `--full` text);
  OpenAlex/bioRxiv return title/authors/date/citations + abstract with links to
  the DOI and PDF (they have no *extracted* full text, so `--full` just points you
  at the PDF).
- **The paper's code: `GitHub: <url>` line.** When alphaXiv has a GitHub repo linked
  to the paper, `orx paper` prints it as the first line (with `--full` too). If the
  report leaves you with questions about *how* something was actually implemented —
  exact hyperparameters, training loop details, a trick the paper glosses over —
  clone the repo into a temp dir and read the code:

  ```sh
  dir=$(mktemp -d) && git clone --depth 1 <githubUrl> "$dir"
  ```

  Inspect it there (grep for the model/optimizer setup, read the configs), and rely
  on it as the ground truth for reproducing the paper. No line means no repo is
  linked. Note the linked repo is the most-starred one associated with the paper —
  occasionally a big framework rather than the paper's own code; sanity-check the
  repo name before leaning on it.
- **Report first, full text only when needed** (alphaXiv). The default report is a
  compact (~10 KB) structured analysis and is enough for most questions. Reach for
  `--full` only when the report is missing a specific detail — it returns the entire
  paper. OpenAlex/bioRxiv have no extracted full text; follow the printed PDF/DOI
  link when you need the body.
- **404s are normal answers, not errors of yours.** An alphaXiv paper whose report
  hasn't been generated yet exits non-zero with a hint to try `--full`; one with no
  extracted text yet points you at the arXiv PDF. A DOI/id unknown to bioRxiv/OpenAlex
  likewise exits non-zero with a hint — try `orx lit --source …` to find the right id.
- Override hosts with `ALPHAXIV_API_URL`/`ALPHAXIV_WEB_URL` (alphaXiv),
  `OPENALEX_API_URL`, or `BIORXIV_API_URL` if you ever need to point elsewhere;
  `OPENALEX_MAILTO` sets the contact OpenAlex's polite pool wants.
- **Sources can be turned off** in the dashboard's Settings → Literature sources.
  A disabled source makes `orx lit --source <it>` / `orx paper <its id>` exit
  non-zero with a hint; bare `orx lit` uses the first enabled source. Getting that
  error means the user disabled it — respect the choice, don't work around it.

**Grounding a research loop in literature.** Before forming hypotheses for a project
(step 2 of the auto-research loop), search the literature for prior art on the knob
you're about to vary, pull the most relevant report, and let it inform the change you
write into a child's description:

```sh
orx lit "learning rate warmup schedules transformers" --limit 5
orx paper <bestPaperId>          # read its report; cite the idea in the child's --description
```
