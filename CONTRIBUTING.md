# Contributing to Ensemble

Thanks for wanting to help. Bug reports, playtest logs, scenario ideas and pull requests are all welcome.

## The contribution terms

Ensemble's code is public under the PolyForm Noncommercial License (see `LICENSE`), but the project owner may also release paid versions (for example a one-click desktop build). So contributions need slightly broader terms than the public license:

**By submitting a contribution (code, text, scenarios or other material) to this repository, you confirm that it is your own work or that you have the right to submit it, and you grant Umedyn a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use, modify, distribute, sublicense and commercialize your contribution as part of Ensemble or related works, under any license terms.**

You keep the copyright to your contribution, and you can use it however you like elsewhere. Your contribution is still available to everyone else under the public license.

If you don't agree with these terms, please don't open a pull request; issues and feedback are still very welcome.

## Before you open a pull request

- Read `CLAUDE.md` (rules that keep the game consistent) and `docs/DESIGN.md` (why things work the way they do).
- Run `npm test` and `npm run check`. If you changed the page, also run `npm run test:ui`.
- If you change engine behavior, add a test for it.
- Keep changes focused; one fix or feature per pull request.

## Playtest logs

Logs from real models are the most useful thing you can send. Include the model, quantization, backend (KoboldCpp adapter or API provider), the scenario, your action and time step, and the KoboldCpp console output or the Debug panel contents. Remove API keys before sharing.
