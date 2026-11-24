# dim-orchestrator

A DimOS Desktop app that draws a running dimos Orchestrator (`dimos/orchestration/`) live: its nested state machine,
which nodes are active, each transition as it fires, the blackboard, and a rewind timeline. Static app: Desktop serves
`frontend/` as is, no build.

## Layout

- `dimos.yaml`, `icon.svg`: the app's contract with Desktop and its icon.
- `frontend/index.html`, `style.css`: the page. Only `theme.css` tokens for colors, fonts and radii.
- `frontend/js/`
  - `api.js`: finds the Orchestrator module (`GET active/modules` on the dimos gateway), then, through Desktop's
    zenoh-gateway, publishes `true` on `orchestrator_state_request` and follows `orchestrator_state` (a JSON String
    per step: active nodes, blackboard, calls, timers, the definition, and the RPCs and streams the file uses). View
    only: no RPCs, no editing.
  - `main.js`: discovery and the stream-following loop, and which step is shown.
  - `model.js`: the definition as a graph (nodes, `done`/`failed` markers, start dots, transition and fallback edges).
  - `layered.js`: dimos-react's layered layout, as JS. `layout.js`: the nested layout built on it (each compound lays
    out its inside left-to-right or top-to-bottom, whichever fits the screen better).
  - `layout_elk.js`: the same graph laid out by ELK (vendored in `frontend/vendor/elk/`, rebuilt by
    `tools/build_elk.sh`), in a worker. The "Edges" setting (graph's bottom-left) picks Curves or Arcs (`layout.js`;
    Arcs are dimos-react's flow edges) or Corners or Splines (ELK).
  - `graph.js`: the SVG, animation of fired edges and entered nodes, timers, pan/zoom/pinch.
  - `history.js`: every step seen, with the blackboard rebuilt at each one (the rewind store).
  - `blackboard.js` (also the RPCs list, hover for a docstring, and the Streams list), `details.js`, `cel.js`, `timeline.js`: the right-hand table, hover/tap details, CEL highlighting
    (tree-sitter, `frontend/vendor/`), and the bottom timeline.
  - `friendly.js`: a blackboard value drawn for people (objects as tables, lists as chips that turn into a column
    when they don't fit), used in an opened blackboard row.
  - `yaml_highlight.js`: the YAML view's highlighting, which knows the file format (CEL fields, RPCs, nodes, outcomes).
  - `source.js`: the file over the graph, as TOML or converted to YAML, highlighted. The converters are vendored:
    `frontend/vendor/formats/`, rebuilt by `tools/build_formats.sh`.
- `tools/dev.js`: serves the app like Desktop does, with `/gateways/dimos/*` proxied to a dimos gateway.
- `tools/record_demos.js`: records the demo videos. `tools/build_cel_wasm.sh`: rebuilds the vendored CEL grammar.

## Trying a change

Run any blueprint with an Orchestrator (`dimos --viewer none run go2-sim-patrol`, or `m20-patrol` on the robot). The
page follows it through Desktop's zenoh-gateway, so open it in Desktop. `?preview=<definition.json>` draws a
definition with nothing running (`deno run -A tools/dev.js` serves the page alone for that).
Installed in Desktop, edit `~/.dimos/apps/dim-orchestrator/` and reload the page.

Before committing: `dimos-desktop app check .`.
