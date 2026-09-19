-- Bring the production page-flip reader in line with its seed asset.
--
-- 20260919131000 seeded cms.book_editions from the seed-assets HTML as it
-- stood on main. Two later edits to seed-assets/books/page-flip-reader.html
-- reach a local database through `pnpm db:migrate` (seedBookEditions) but
-- not production, which runs `atlas migrate apply` only:
--
-- 1. The cover URL keeps location.search. Without it, the reader drops ?e=&c=
--    from the address bar on the cover page, so a refresh cannot redeem the
--    rotated code and the visitor lands back on the lead form.
-- 2. The no-JavaScript link points at /read?e=field-manual. The AWS site has
--    no /field-manual object, so the old link returns 404.
--
-- Each replace() is a no-op on a row that already carries the new text, so
-- this is safe after seedBookEditions has run and safe to re-run.

UPDATE cms.book_editions
SET
  html = replace(
    replace(
      replace(
        html,
        'id === "cover" ? location.pathname : "#" + id',
        'id === "cover" ? location.pathname + location.search : "#" + id'
      ),
      'href="/field-manual"',
      'href="/read?e=field-manual"'
    ),
    'oxagen.sh/field-manual</a>',
    'oxagen.sh/read?e=field-manual</a>'
  ),
  updated_at = now()
WHERE slug = 'page-flip-reader';
