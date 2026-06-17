# Welcome to your Knowledge Base

A personal wiki of markdown notes — the "IDE frontend" for a knowledge base an
LLM agent compiles and maintains for you. You point it at raw sources (papers,
articles, repos, datasets, images); it writes the wiki; you read, edit, search
and query it here.

## The loop

1. **Ingest** — drop source documents into a `raw/` pile.
2. **Compile** — an LLM summarizes each source, extracts concepts into
   articles, and links them together with `[[wiki links]]`.
3. **Q&A** — ask questions against the whole wiki; it researches across notes.
4. **File outputs back** — answers, slides and charts become new notes, so your
   explorations always add up.
5. **Lint** — periodic health checks find inconsistencies, missing data and
   interesting new connections.

## Writing notes

- Link another note with double brackets: `[[Data Ingest]]`.
- Give a link custom text with a pipe: `[[Q and A|ask questions]]`.
- A link to a note that doesn't exist yet shows in a different color — click it
  to start that note.

Outgoing links and backlinks for the open note appear on the right, so the
graph of your knowledge maintains itself as it grows.

> You rarely write the wiki by hand — that's the agent's job. You mostly read
> it, ask it questions, and file the results back in.
