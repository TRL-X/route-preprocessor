# Development agreements

Route Studio is a local-first route editor and device uploader. Read `README.md`
and `docs/architecture.md` before changing code; consult the relevant specification,
preprocessing or i18n notes when working in those areas.

## Keep changes focused

- State which existing modules own the requested behavior before editing.
- Preserve existing behavior unless the request explicitly changes it. Keep
  unrelated cleanup separate from feature work.
- Reuse existing functions, components and hooks. Add dependencies or shared
  abstractions only when a concrete requirement needs them, and explain why.
- Keep workflow completion, navigation and confirmation invalidation rules in
  `src/app/flow.ts`; UI components consume those rules rather than duplicating them.
- Keep processing and file-format validation in `src/core`. Core must not depend
  on the UI, application state, device transport or persistence. Keep `src/device`
  independent of route processing and the UI. Follow the enforced import
  boundaries in `eslint.config.js`.

## Verify behavior

- Run `npm run check` for formatting, lint, types, unit tests and the production
  build. For interaction changes, also run the relevant Playwright tests with
  `npm run test:e2e -- <test-file>`.
- Add or adjust tests for changed rules and regressions. Prefer observable
  behavior and protocol contracts over assertions about internal implementation.
- Preserve reference vectors and original route fixture bytes. Do not weaken
  validation, tests or lint rules to make a check pass.
- Update the existing documentation when responsibilities, commands or behavior
  change. Write documentation, code comments and test descriptions in English;
  keep interface strings in locale resources.
- At delivery, explain the behavior affected, checks actually run and any
  remaining verification limits. Distinguish simulated Bluetooth tests from
  physical-device testing.
