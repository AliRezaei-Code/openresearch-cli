---
name: orx-lit
description: "Search and read research papers. For alphaXiv discovery, the main agent directly calls independent keyword and embedding retrieval primitives, ranks their candidates, and decides any focused follow-up calls itself. Use for literature reviews, related work, prior art, papers, authors, methods, benchmarks, or research claims; never delegate the retrieval loop to a sub-agent."
---

# Literature retrieval

For alphaXiv discovery, you are the retrieval ranker. Call the keyword and
embedding primitives yourself, inspect the returned candidates, and decide
whether another focused call is warranted. Never delegate this loop to a
sub-agent, and do not use `orx lit` as the alphaXiv orchestration layer.

Each command performs exactly one public endpoint request and emits its
structured JSON result. No login is required:

```sh
orx discover keyword "<exact keyword query>"
orx discover embedding "<semantic description in the user's terms>"
```

- `keyword` searches title, abstract, and full text. Results include the match
  snippets that explain why each paper was retrieved. Use short exact terms:
  method names, acronyms, benchmarks, authors, or title phrases. Use only terms
  stated by the user or observed in results; never invent an acronym expansion.
- `embedding` searches titles and abstracts semantically, then reranks by
  similarity and the requested priority. Use the user's actual question or a
  concise description of a genuinely missing facet.
- Both return versionless `paperId`, title, abstract, publication date, and
  votes. Keyword results also include snippets.

## Date and ranking controls

Retrieval is not date-bounded unless you supply a bound. Add the same controls
to either primitive when the question calls for them:

```sh
orx discover keyword "<query>" --published-after 2024-01-01 --prioritize recency
orx discover embedding "<query>" --published-before 2012-01-01 --prioritize historical
```

- `--published-after` and `--published-before` are inclusive `YYYY-MM-DD`
  bounds. Do not invent a cutoff merely to favour newer work.
- Older or narrow `--published-before` embedding searches can return a thin or
  empty candidate set because the upper bound is applied after vector retrieval.
  Report what comes back; do not treat an empty set as proof that no literature
  exists or retry the identical query and window.
- `--prioritize` is `default`, `recency`, `historical`, or `popular`.
- Use `recency` for explicitly new/latest work. Use `historical` for seminal or
  foundational work. Use `popular` only when the user asks about votes,
  popularity, or community standing.

## Main-agent retrieval loop

1. For the first round, issue both primitive calls yourself (in parallel when
   possible). The keyword query should contain focused exact terms; the
   embedding query should express the full question in the user's language.
2. If the exact terms mix one or more 2–10 character tokens containing at least
   two capital letters with other words, also call `keyword` with only those
   tokens. Treat this as initial acronym recovery, not a follow-up.
3. Inspect every returned set. Rank papers by how directly they answer the
   question, using match snippets as evidence rather than blindly trusting API
   order. Deduplicate by `paperId`.
4. Stop if the evidence is sufficient. Easy requests should normally make no
   follow-up; medium requests may make one; difficult literature reviews may
   make at most two. A follow-up must target a concrete ambiguity, missing
   subtopic, author, method, or phrase learned from prior results—not merely
   rephrase the same search.
5. Read the best papers with `orx paper <paperId>`, then answer with the most
   relevant 3–5 unless the user requests another number. A request for more
   papers requires focused additional queries; the retrieval primitives have
   fixed result counts rather than a `--limit` flag.

## Reading selected papers

`orx paper` auto-detects an arXiv id/URL, bioRxiv DOI, other DOI, or OpenAlex
`W…` id. For alphaXiv it returns a compact structured report; use `--full` only
when that report omits a needed detail. If the report is not generated yet, the
command tells you to retry with `--full`; if extracted text is unavailable, use
the PDF link it returns.

When alphaXiv has an associated repository, `orx paper` prints `GitHub: <url>`
first. It is the most-starred associated repository and can be a framework
rather than the paper's own code, so sanity-check it before treating it as the
implementation.

For non-arXiv or biomedical coverage, `orx lit --source openalex` and `orx lit
--source biorxiv` remain supplemental corpus searches. All discovery and paper
commands honor the user's disabled literature-source settings; do not work
around an error saying a source is disabled.
