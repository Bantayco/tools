-- D1 schema for tools.bantay.co saved files.
-- Apply:  npx wrangler d1 execute tools --remote --file=./schema.sql   (production)
--         npx wrangler d1 execute tools --local  --file=./schema.sql   (local dev)
CREATE TABLE IF NOT EXISTS items (
  user_id    TEXT NOT NULL,
  tool       TEXT NOT NULL,
  slug       TEXT NOT NULL,
  title      TEXT,
  data       TEXT NOT NULL,        -- the saved doc, as JSON
  updated_at TEXT NOT NULL,        -- ISO timestamp
  PRIMARY KEY (user_id, tool, slug)
);

-- The composite primary key already indexes (user_id) and (user_id, tool)
-- prefixes, covering the dashboard (all of a user's files) and per-tool lists.
