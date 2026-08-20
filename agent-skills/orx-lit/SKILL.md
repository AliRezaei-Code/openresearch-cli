---
name: orx-lit
description: "Run agent-ranked literature retrieval and read papers via alphaXiv, OpenAlex, and bioRxiv (`orx lit` / `orx paper`). Use for academic topics across CS/ML and biomed. The main agent inspects keyword and semantic candidates, makes only focused follow-ups, and does not delegate the retrieval loop to a sub-agent."
---

**The preferred literature tool.** For anything academic or research-related —
papers, authors, blog posts, model releases — start with `orx lit`, not a web
search. You are the retrieval ranker: call the tool, inspect its candidates,
decide whether one focused follow-up is needed, and return the papers that best
answer the user's question. Do not delegate this loop to a sub-agent.

For alphaXiv, one `orx lit` call runs a full-text keyword search and a semantic
title/abstract search concurrently. It prints the two candidate sets separately;
the CLI does not merge their scores or use an LLM to choose for you. When a mix
of short acronyms and other terms could bury an overloaded acronym, it also runs
an acronym-only keyword search in that same round.

## Retrieval loop

1. Make one broad initial call. The positional argument is the semantic question.
   Pass each exact method name, acronym, benchmark, author, or title phrase with
   a repeatable `--keyword`. Use only terms the user wrote or that appeared in a
   prior result; never guess an acronym's expansion.
2. Read both result sets and rank 5-15 papers by topical fit. The ordering within
   each set already accounts for the selected freshness/popularity preference.
3. Stop when the candidates cover the question. For an easy query this should be
   the first call. Make one follow-up call only for a concrete missing acronym,
   method, benchmark, organization, or subtopic; exceptionally broad or ambiguous
   work may earn a second. Never run exploratory or overlapping follow-ups.
4. Preserve the same date bounds and `--prioritize` value on follow-ups. Those
   constraints came from the user's request; silently widening them answers a
   different question.

```sh
orx lit "How do GRPO and DAPO differ?" --keyword GRPO --keyword DAPO
orx lit "work applying test-time compute to theorem proving" \
  --keyword "test-time compute" --keyword "theorem proving"
```

`orx lit --source` picks the corpus (all need **no `orx login`**; public hosts,
not the OpenResearch API):
- **`alphaxiv`** (default) — 2.5M+ arXiv papers (CS, math, physics, stats,
  q-bio/fin, EE). Parallel keyword and semantic retrieval for agent ranking.
- **`openalex`** — the OpenAlex scholarly graph (250M+ works, every discipline,
  incl. published journal articles). Ranked by relevance; hits carry citation counts.
- **`biorxiv`** — biology preprints. bioRxiv has no search API, so this searches
  OpenAlex filtered to bioRxiv's corpus; `orx paper <doi>` then fetches the
  preprint from bioRxiv itself. Use for biomed, where alphaXiv is thin.

```sh
orx lit "speculative decoding for LLMs" --keyword "speculative decoding"
orx lit "new work on KV cache compression" --keyword "KV cache" --prioritize recency
orx lit "transformer optimization" --keyword transformers --published-after 2024-01-01
orx lit "neural networks before AlexNet" --published-before 2012-01-01 # historical alphaXiv search
orx lit "graph neural networks" --source openalex         # OpenAlex: cross-discipline, citation counts
orx lit "spike protein binding affinity" --source biorxiv # biology preprints via bioRxiv
orx lit "kv cache compression" --json                     # raw JSON (uniform LitHit shape) for piping
orx paper 2401.12345                                      # alphaXiv report (auto-detected)
orx paper 10.1101/2020.02.11.944462                       # bioRxiv preprint (auto-detected from the DOI)
orx paper 10.1038/nature14539                             # OpenAlex metadata + abstract (any other DOI / W-id)
orx paper 2401.12345v2 --full                             # alphaXiv full extracted text (fallback)
```

- **`orx lit`** prints alphaXiv keyword and semantic candidate sections with
  `[ID=...]`, title, date, votes, abstract, and matching full-text snippets where
  available. OpenAlex/bioRxiv print a single ranked list with citation counts. The
  **`id`** is what you feed to `orx paper` — an arXiv id (alphaXiv), a DOI
  (bioRxiv/OpenAlex), or an OpenAlex `W…` id. Results are relevance-ranked, capped
  at `--limit` per retrieval strategy (default 15 for alphaXiv, 5 for other
  sources). `--json` emits a deduplicated uniform hit array in keyword-first
  strategy order, not a single cross-strategy ranking (`source`, `id`,
  `title`, `abstract`, `publicationDate`, and `votes`/`citations`/`snippets` where
  they apply) for piping.
- **alphaXiv searches default to papers from the past three months.** This keeps
  ordinary discovery current. Use `--published-after YYYY-MM-DD` and/or
  `--published-before YYYY-MM-DD` whenever the user names another period or the
  question calls for older, seminal, or historical work. An upper bound without
  a lower bound removes the default lower cutoff. These flags apply only to
  `--source alphaxiv`.
- **`--prioritize default|recency|historical|popular`** changes alphaXiv's
  ranking after topical relevance. Use `recency` for what is new, `historical`
  for seminal/foundational work (and widen the date window), and `popular` only
  when the user explicitly asks about votes, popularity, or community standing.
  “Best” alone does not mean most upvoted.
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
- **Sources can be turned off** by the user. A disabled source makes `orx lit
  --source <it>` / `orx paper <its id>` exit
  non-zero with a hint; bare `orx lit` uses the first enabled source. Getting that
  error means the user disabled it — respect the choice, don't work around it.

**Grounding a research loop in literature.** Before forming hypotheses for a project
(step 2 of the auto-research loop), search the literature for prior art on the knob
you're about to vary, pull the most relevant report, and let it inform the change you
write into a child's description:

```sh
orx lit "learning rate warmup schedules for transformers" --keyword "learning rate warmup"
orx paper <bestPaperId>          # read its report; cite the idea in the child's --description
```
