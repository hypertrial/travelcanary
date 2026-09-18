# Agent entry point

This repository uses the Universal Pad specification for non-trivial agentic work.

**Git** is the source of truth for code. **CI** is the source of truth for verification. **Pad** is the source of truth for intent, scope, status, dependencies, decisions, evidence, and handoffs.

Read [`PROJECT_AGENT.md`](PROJECT_AGENT.md) before implementation. It holds repository-specific invariants, stack notes, and the native verification commands wrapped by `scripts/verify-fast` and `scripts/verify`.

## Work

Use Pad collections **Work** and **Plans** only.

Work types: Feature, Bug, Refactor, Investigation, Maintenance. Plans are multi-ticket containers only.

Statuses (machine values): `backlog`, `ready`, `in-progress`, `blocked`, `review`, `done`.

Risk: `r0` (trivial), `r1` (normal), `r2` (consequential), `r3` (critical).

Do not create Ideas, Tasks, chores, or extra default types. Do not run the Pad onboard playbook.

## Lifecycle

specify → test/reproduce → implement → targeted verification → full verification → adversarial review → fix findings → re-verify → CI → evidence → done

Do not start material implementation until the ticket is `ready`: intended behavior, invariants, regression surface, and verification are specified.

Implement the smallest coherent change. Do not silently expand scope. Put unrelated work in a new Pad ticket.

## Verification

Development feedback: `scripts/verify-fast`

Completion gate: `scripts/verify`

A ticket is not `done` while required verification is failing or unrun. Record why if a required command cannot run.

## Evidence and handoffs

Record decisions with `pad item decide`. Represent blockers as Pad dependencies, not prose.

Incomplete work must include a handoff a fresh agent can resume without chat history.

R2/R3 work needs independent adversarial review before `done`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
