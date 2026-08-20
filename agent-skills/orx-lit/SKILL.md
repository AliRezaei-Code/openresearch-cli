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

You are the low-latency retrieval ranker. Run the loop below yourself.

### Set up the retrieval query

1. Build focused keyword terms using only wording from the user or prior tool
   results. Never guess an acronym expansion. General-purpose padding reduces
   result quality.
2. Build one semantic question in the user's terms. A short faithful question
   is better than a padded reformulation.
3. Estimate retrieval difficulty from 1–10. This controls a budget of complete
   follow-up rounds: difficulty 1–3 gets 0 rounds, 4–7 gets 1, and 8–10 gets 2.
4. Resolve one publication window and priority for the request. Every initial
   and follow-up call must inherit those exact controls; never widen a window or
   change priority during the loop. Every returned candidate already satisfies
   that window, so rank what is available instead of lamenting well-known work
   that the user excluded.

### Run and rank

1. Run the initial keyword and embedding calls concurrently when possible. If
   the keyword terms mix other terms with one or more 2–10 character tokens
   that start with a letter, contain only letters, digits, or hyphens, and have
   at least two uppercase letters, concurrently run one additional keyword call
   whose query is exactly those acronym tokens joined by spaces and nothing
   else. This recovery call is part of the initial round.
2. Treat initial calls independently: retain every successful result set when
   another call fails. If none returns results and follow-up budget remains,
   use a round only when a focused recovery query is likely to work.
3. Inspect and deduplicate every candidate by `paperId`. The API order already
   blends topical relevance with the requested priority:
   - With `recency`, freshness is already upranked and old accumulated votes
     are damped. Reorder only for topical fit; do not exclude an older but much
     better match.
   - With `popular`, votes already dominate among topically plausible results.
     Keep heavily voted relevant papers, but drop off-topic ones.
   - Otherwise, topical relevance remains primary with freshness and votes
     already nudging the order. Do not apply those preferences a second time.
4. If the initial candidates provide solid topical coverage, stop immediately
   and rank 5–15 IDs. Fast and slightly less complete is better than an
   exploratory search. Prefer fewer strong papers over padding.
5. Otherwise, spend at most the difficulty-derived number of follow-up rounds.
   One round targets one concrete missing acronym, method, benchmark,
   organization, title phrase, or subtopic and may run keyword search,
   embedding search, or both. When both are useful for that same missing angle,
   call both primitives and count them together as one round. Never spend a
   round merely rephrasing an existing search. Re-evaluate after each round and
   stop as soon as coverage is sufficient. The budget is a hard cap, not a
   target: track the remaining rounds, and when none remain, rank what you have
   even if coverage still feels incomplete.
6. Drop each selected ID that did not appear in a successful initial or
   follow-up result, retaining the surviving IDs in your chosen rank order. If
   no selected ID survives, fall back to the first 15 unique IDs in observation
   order, with initial results before follow-up results. Never invent or recall
   an ID.

Batch all facets into one broad retrieval loop and plan against a cap of two
complete loops per user turn. If a genuinely distinct topic still forces a
third or fourth loop, run it in shallow mode: initial searches only, with zero
follow-up rounds. This degradation is a backstop, not permission to plan extra
loops. Refuse a fifth loop and answer from the papers already found.

After retrieval is complete, read the 3–5 most load-bearing candidates with
`orx paper <paperId>` (or the number the user requested) and synthesize the
answer. Do not narrow to 3–5 papers before the retrieval loop has produced its
ranked 5–15 candidate set.

In the final answer, link every alphaXiv/arXiv paper title or paper ID to
`https://www.alphaxiv.org/abs/<versionless-paperId>`. Never return an
`arxiv.org` link for those papers. Keep DOI, bioRxiv, and OpenAlex links for
papers from those respective sources.

## Reading selected papers

`orx paper` auto-detects an arXiv id/URL, bioRxiv DOI, other DOI, or OpenAlex
`W…` id. For alphaXiv it returns a compact structured report; use `--full` only
when that report omits a needed detail. If the report is not generated yet, the
command tells you to retry with `--full`; if extracted text is unavailable, use
the alphaXiv paper link it returns.

When alphaXiv has an associated repository, `orx paper` prints `GitHub: <url>`
first. It is the most-starred associated repository and can be a framework
rather than the paper's own code, so sanity-check it before treating it as the
implementation.

For non-arXiv or biomedical coverage, `orx lit --source openalex` and `orx lit
--source biorxiv` remain supplemental corpus searches. All discovery and paper
commands honor the user's disabled literature-source settings; do not work
around an error saying a source is disabled.
