-- D1 schema for tools.bantay.co saved files.
-- Apply:  npx wrangler d1 execute tools --remote --file=./schema.sql   (production)
--         npx wrangler d1 execute tools --local  --file=./schema.sql   (local dev)
CREATE TABLE IF NOT EXISTS items (
  user_id         TEXT NOT NULL,
  tool            TEXT NOT NULL,
  slug            TEXT NOT NULL,
  title           TEXT,
  data            TEXT NOT NULL,   -- the saved doc, as JSON
  updated_at      TEXT NOT NULL,   -- ISO timestamp
  -- Published snapshot: set when the owner "publishes" this row and can be read
  -- unauthenticated at /public/<tool>/<slug>. Edits to `data`/`title` do NOT
  -- affect the published copy until the owner re-publishes.
  published_data  TEXT,
  published_title TEXT,
  published_at    TEXT,            -- ISO timestamp; NULL means "not published"
  PRIMARY KEY (user_id, tool, slug)
);

-- The composite primary key already indexes (user_id) and (user_id, tool)
-- prefixes, covering the dashboard (all of a user's files) and per-tool lists.
