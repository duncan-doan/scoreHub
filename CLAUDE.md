# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

---

## Project: Badminton championship website

Scores, standings and bracket for the 7-team internal tournament. Rules and decisions: `docs/SPEC.md`. Architecture, diagrams, build plan and risks: `docs/ARCHITECTURE.md`. Originals: `docs/Điều lệ giải.pdf` and `docs/Giai_cau_long_doi_nam_nu_7_doi.xlsx`.

### Stack (ask before changing)

- Node.js + Express, SQLite (better-sqlite3), plain HTML/CSS/JS.
- No frontend framework, no build step, no new dependencies without asking.
- Playwright is approved as a dev-only dependency for checking the pages; it never goes in the Docker image.

### Commands

- `npm test`: run after every change
- `npm run test:ui`: Playwright checks, phone-sized, both languages
- `npm start`: http://localhost:3000
- `docker compose up -d --build`: http://localhost:8080
- `npm run backup`: safe copy of the database (on the droplet: `docker compose exec app npm run backup`)

### Rules that must hold

- `server/rules.js` is pure: no database, no Express, no clock.
- Store only what people enter; compute everything else in `rules.js`.
- Every UI string exists in both `vi` and `en` in `public/i18n.js`.
- A match is locked once a match that depends on it is finished; while a dependent match is live, changes that would alter its teams are refused (SPEC §7).
- Live point and undo requests carry the point count the screen shows; a mismatch is refused (SPEC §5.2).

### Deployment

- Shared DigitalOcean droplet, port 8080, next to another service. Compose project is named `badminton`.
- Never suggest `docker system prune` or touching other containers.
- Never commit `.env` or `data/*.db`.
