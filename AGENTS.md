# dim-orchestrator

A DimOS Desktop app that draws a running dimos Orchestrator (`dimos/orchestration/`) live: its nested state machine,
which nodes are active, each transition as it fires, the blackboard, and a rewind timeline. Static app: Desktop serves
`frontend/` as is, no build.

## Layout

- `dimos.yaml`, `icon.svg`: the app's contract with Desktop and its icon.
- `frontend/index.html`, `style.css`: the page. Only `theme.css` tokens for colors, fonts and radii.
- `frontend/js/`
  - `api.js`: the dimos gateway calls: finds the Orchestrator module (`GET active/modules`) and calls its RPCs
    `definition`, `state`, `journal(after, limit)`, `set_value(key, value)` and `set_source(source)` (`POST active/modules/{id}/rpcs/{name}`).
  - `main.js`: discovery and the journal-following loop, and which step is shown.
  - `model.js`: the definition as a graph (nodes, `done`/`failed` markers, start dots, transition and fallback edges).
  - `layered.js`: dimos-react's layered layout, as JS. `layout.js`: the nested layout built on it (each compound lays
    out its inside left-to-right or top-to-bottom, whichever fits the screen better).
  - `graph.js`: the SVG, animation of fired edges and entered nodes, timers, pan/zoom/pinch.
  - `history.js`: every step seen, with the blackboard rebuilt at each one (the rewind store).
  - `blackboard.js`, `details.js`, `cel.js`, `timeline.js`: the right-hand table, hover/tap details, CEL highlighting
    (tree-sitter, `frontend/vendor/`), and the bottom timeline.
  - `source.js`: the file over the graph, as its TOML or converted to YAML, highlighted and editable; Apply calls the
    `set_source` RPC (a YAML edit is converted back to TOML first), which checks the text against the running
    blueprint and restarts the engine on it. The converters are vendored: `frontend/vendor/formats/`, rebuilt by
    `tools/build_formats.sh`.
- `tools/dev.js`: serves the app like Desktop does, with `/gateways/dimos/*` proxied to a dimos gateway.
- `tools/record_demos.js`: records the demo videos. `tools/build_cel_wasm.sh`: rebuilds the vendored CEL grammar.

## Trying a change

The app needs a dimos with the orchestrator's state RPCs (branch `jeff/feat/orchestrator-state`, stacked on Andrew's
orchestrator PRs). In that checkout:

```sh
dimos --viewer none run orchestration-demo-patrol      # or delivery, inspection, shift, safety, jam
DIMOS_APP='{"socket":"/tmp/dimorch-gw.sock"}' .venv/bin/python -m experimental.gateway --port 7811 --no-zenoh
```

Then `deno run -A tools/dev.js` here and open http://127.0.0.1:8765/apps/dim-orchestrator/. Reload to see an edit.
Installed in Desktop, edit `~/.dimos/apps/dim-orchestrator/` and reload the page.

Before committing: `dimos-desktop app check .`.
