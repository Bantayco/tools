-- Adds the "publish" snapshot columns to `items` so a saved doc can be exposed
-- read-only at /public/<tool>/<slug>. Apply once per environment:
--   npx wrangler d1 execute tools --local  --file=./migrations/2026-07-06-add-publish-columns.sql
--   npx wrangler d1 execute tools --remote --file=./migrations/2026-07-06-add-publish-columns.sql
ALTER TABLE items ADD COLUMN published_data  TEXT;
ALTER TABLE items ADD COLUMN published_title TEXT;
ALTER TABLE items ADD COLUMN published_at    TEXT;
