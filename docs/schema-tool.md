# Schema Tool (🧩 Schema in the sidebar)

A sidebar page for reading and changing the site's JSON-LD schema
(Header Footer Code Manager snippets) on the WordPress site that runs the
`phr-schema/v1` API (staging for now).

## What it does

- **Assistant**: ask in plain English ("change guest bathroom timelines to 3-4 weeks").
  The AI searches every snippet and *stages* one changeset with counts and a before/after.
  You apply it with one click (or Ctrl+Enter). It never writes on its own unless
  auto-apply is turned on in Settings for small changes.
- **Snippets**: browse, filter by URL, search inside schema code (text or regex), edit
  JSON-LD directly with live validation. Saving creates a changeset and applies it.
- **Sources**: connect Google Sheets / Docs (e.g. the SEO sameAs sheet). The assistant reads them with
  formatting kept ({red} text, highlights, ~~strikethrough~~, cell notes, links), tracks rows added/changed
  since the last read, and can sync schema to them. Each source has a "how to read it" note. Share the file
  (Viewer) with the MCD Google service account; reader: `mcd/scripts/schema_source_reader.py`.
- **History**: every change with who/when/how many snippets. **Undo** restores the exact
  previous content of each snippet (skips any snippet edited again since).
- **Page check**: what schema a page outputs (HFCM / Rank Math / inline), whether it all
  parses, canonical URL, and FAQ schema vs. visible FAQ mismatches.

Guards: only text inside `<script type="application/ld+json">` changes, every result must
parse as JSON, and a change is refused if the snippet changed on the site since it was staged.

## Files (all new except one small hook)

```
src/lib/schema-tool/        config, WordPress client, SQLite store, engine, changesets, page check, AI agent
src/app/api/schema-tool/    status, snippets, snippets/[id], chat, changesets, changesets/[id], page-check
src/components/schema-tool/ SchemaToolView (UI), ChangesetCard (+ review drawer), SourcesPanel, ui primitives
mcd/scripts/schema_source_reader.py  Google Sheets/Docs reader that keeps formatting (same service account)
src/app/page.tsx            +1 import, +1 sidebar NAV item, +1 case in mainContent()
```

Database: five new tables in the existing SQLite DB (`schema_tool_changesets`,
`schema_tool_items`, `schema_tool_messages`, `schema_tool_settings`, `schema_tool_sources`), created on first use
with `CREATE TABLE IF NOT EXISTS`. Nothing existing is altered. Before/after snippet text is
stored zlib-compressed.

## Environment (`.env.local` on the VPS)

```
SCHEMA_TOOL_WP_URL=https://znee8v7mwj-staging.wpdns.site
SCHEMA_TOOL_WP_USER=schemabot
SCHEMA_TOOL_WP_APP_PASSWORD=<WordPress application password>
# optional
SCHEMA_TOOL_PROD_ORIGIN=https://phxhomeremodeling.com
ANTHROPIC_API_KEY=<Claude API key, e.g. sk-ant-usr-… from platform.claude.com/settings/keys>
ANTHROPIC_WORKSPACE_ID=<wrkspc_… — only if the key isn't scoped to a workspace>
SCHEMA_TOOL_ANTHROPIC_MODEL=claude-sonnet-5-5
# SCHEMA_TOOL_SA_JSON=/path/to/sa.json   # optional; defaults to INITIATIVES_SA_JSON etc.
# otherwise it uses the existing OPENAI_API_KEY (SCHEMA_TOOL_OPENAI_MODEL || OPENAI_MODEL)
```

Switching to the live site after cutover = change `SCHEMA_TOOL_WP_URL` (the live site needs
the `phr-schema-api.php` mu-plugin installed) and restart.
