# frontend/data-layer — switched OFF, kept for reference

An experiment in a repository/worker data layer over the device's SQLite
(`db.js`, `db-worker.js`, `schema.js`, `repositories/`, `test.html`). It never
became the app's path and it is not loaded by `index.html`, so none of it runs
and none of it is built into `dist/`.

Kept because the schema and the repository shapes are worth reading if a local
cache layer is ever wanted again. See `frontend/db/DISABLED.md` for the same
decision about the SQLite engine itself, and `KoshAgarConfig.legacy` in
`frontend/config.js` for the switches.
