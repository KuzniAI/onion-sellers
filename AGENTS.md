# Agent notes

This project runs directly from Node with native TypeScript support —
there is no build step. `npm start` executes `src/index.ts` as-is via
`node --env-file-if-exists=.env src/index.ts`. Do not add a compile
step or transpile to `.js` before running.

## Edit / lint / format loop

After changing any `.ts` file, run in this order:

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npm run format
```

- `npm run typecheck` runs `tsc --noEmit` to type-check `src`. Fix any
  reported type errors before continuing.
- `npm run lint` runs `oxlint` with its default rule set. Fix any
  reported errors before continuing.
- `npm run format` runs `oxfmt` with its default settings and rewrites
  files in place. Run it again after fixing lint errors, since edits
  can reintroduce formatting drift.
- Re-run `npm start` to confirm the code still runs correctly under
  Node's TS support after linting/formatting.

Repeat edit → typecheck → lint → format until `tsc` and `oxlint`
report no issues and `oxfmt` makes no further changes.
