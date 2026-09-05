# frontend/db — switched OFF, kept for reference

`sqlite.js` was the app's database when the books lived in the browser, with
`schema-relational.sql` as its schema. The books live in Postgres now.

**It does not run, and it is not shipped.** `index.html` has no `<script>` tag
for it, so `window.KoshDB` never exists; every caller is written as
`if (window.KoshDB && KoshDB.available)` and simply skips — the scenario suite
and the reliability report both do this. `frontend/build.mjs` reads its file
list out of `index.html`, so nothing here reaches `dist/` either.

Why it is off rather than deleted: it worked. But two databases means two
answers to "what is the cash in hand", and the app is built on the rule that
the server gives that answer. A second one sitting there is a second answer
waiting to be believed.

## To revive it

1. Put the tag back in `index.html`, before `app.js`:
   `<script src="./db/sqlite.js"></script>`
2. Set `localSqlite: true` in `frontend/config.js` (`KoshAgarConfig.legacy`).
3. `node frontend/build.mjs` — the build will pick the file up on its own,
   because the list comes from the page.

What stays true either way: nothing here may become a source of figures the
screens act on. Read-only diagnostics only.
