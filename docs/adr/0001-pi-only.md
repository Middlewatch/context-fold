# 0001: context-fold serves Pi only

Date: 2026-08-31
Status: accepted

## Context

The core was ported from Accordion and kept harness-agnostic so a second harness could be
served by writing another adapter. The owner has since committed to publishing Pi tooling
as first-class and Pi-only; any future harness of his own would build each piece
in-process rather than load an external adapter. Cross-harness readiness carried real
overhead: a policy contract wider than its one consumer, duplicate wire shapes, and a
portability promise in the docs.

## Decision

context-fold supports Pi and no other harness. The `src/core` / `src/adapters/pi` split
stays as a pure/effectful boundary rather than a porting seam: the core keeps no clock,
randomness, or I/O because that is what makes deterministic, reversible folding testable. Harness-agnostic breadth with no Pi-side reader is trimmed to observed usage.

## Consequences

Easier: the speculative seam payload (unread `PolicyView`/`ViewBlock` fields, the
duplicate `IndexBlock`/`WireBlock` shapes, write-only `SpoolEntry` token fields) can
shrink without owing a hypothetical adapter anything, and docs stop advertising
portability. Harder: serving a second harness later means superseding this ADR and
rebuilding the abstraction from a narrower base. We now owe: README, DESIGN.md, and
AGENTS.md describe Pi-only support and the purity rationale.
