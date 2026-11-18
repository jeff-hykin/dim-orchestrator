# Orchestrator (DimOS Desktop app)

Watch a dimos Orchestrator run: its nested state machine with the active nodes lit and each transition playing along
its edge, the blackboard grouped by stream values, vars, results and constants, CEL conditions with every name as a pill
showing its value, and a timeline to rewind and replay the session. Vars and stream values can be set from the blackboard.

Install: Desktop's App Store → Install From URL → `https://github.com/jeff-hykin/dim-orchestrator`.

Needs a dimos whose `Orchestrator` has the `definition`, `state`, `journal` and `set_value` RPCs. Try it with
`dimos run orchestration-demo-patrol` (also `delivery`, `inspection`, `shift`, `safety`, `jam`).

Videos of each demo: `deno run -A tools/record_demos.js --dimos <dimos checkout>` (see AGENTS.md).
