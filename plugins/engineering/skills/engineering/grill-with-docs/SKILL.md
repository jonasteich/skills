---
name: grill-with-docs
description: A relentless interview to sharpen a plan or design, which also creates docs (ADR's and glossary) as we go.
disable-model-invocation: true
---

Call the Skill tool twice, for "grilling" and "domain-modeling".

When the grilling is done, recommend the next step by size: `/to-spec` if the work would be more than one ticket, `/to-tickets` if it is small. Start a fresh session only when everything the next step needs is in tickets and on main: on desktop, propose it as a New-task card via `start_session`; in the CLI, tell the user to run `/clear`, then `/to-spec` (or `/to-tickets`). Otherwise ask whether to run it now, and on yes call the Skill tool with "to-spec" or "to-tickets" in this session.
