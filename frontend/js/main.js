// The page: finds a running orchestrator, follows its journal, and keeps the graph, the blackboard and the timeline
// on the step being shown (the newest one, or one picked on the timeline).

import * as api from "./api.js"
import { BlackboardPanel } from "./blackboard.js"
import { ready as celReady } from "./cel.js"
import { edgeDetails, namesFor, nodeDetails, valueDetails } from "./details.js"
import { GraphView, LAYOUT_STYLES } from "./graph.js"
import { History } from "./history.js"
import { SourceView } from "./source.js"
import { buildModel, edgeForRecord } from "./model.js"
import { Timeline } from "./timeline.js"

// How long to wait between journal reads, and between looks for an orchestrator when none runs.
const POLL_S = 0.12
const SEARCH_S = 1.5

const $ = (selector) => document.querySelector(selector)
const wait = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000))

const app = {
    moduleId: null,
    modules: [],
    model: null,
    history: new History(),
    clockOffset: 0,
    pinned: null,
    shownSeq: 0,
    generation: 0,
}

// ---------------------------------------------------------------------------------------------- theme and insets
function applyTheme() {
    try {
        document.documentElement.dataset.skin = localStorage.getItem("portal.theme") || "portal"
        const corners = localStorage.getItem("portal.corners")
        if (corners === "sharp" || corners === "rounded") {
            document.documentElement.dataset.corners = corners
        } else {
            delete document.documentElement.dataset.corners
        }
    } catch {
        // no storage (outside Desktop): theme.css's :root stays
    }
    const round = getComputedStyle(document.documentElement).getPropertyValue("--radius-round").trim()
    document.documentElement.dataset.dots = /^0(px)?$/.test(round) ? "square" : "round"
}
applyTheme()
addEventListener("storage", applyTheme)
addEventListener("message", ({ origin, data }) => {
    if (origin === location.origin && data?.type === "dimos-inset") {
        for (const side of ["top", "bottom", "left", "right"]) {
            document.documentElement.style.setProperty(`--dim-inset-${side}`, `${data[side] ?? 0}px`)
        }
    }
})
if (parent !== window) {
    parent.postMessage({ type: "dimos-inset-request" }, location.origin)
}

// ---------------------------------------------------------------------------------------------- views
const tooltip = $("#tooltip")

function showTip(content, event, pinned = false) {
    // a pinned tip refreshed by a live update (no pointer event) keeps its place: only its contents change
    const refresh = !event && pinned && !tooltip.hidden && tooltip.classList.contains("pinned")
    $("#tooltip-content").replaceChildren(content)
    if (refresh) {
        return
    }
    tooltip.hidden = false
    tooltip.classList.toggle("pinned", pinned)
    const narrow = innerWidth < 700
    if (narrow && pinned) {
        tooltip.style.left = ""
        tooltip.style.top = ""
        tooltip.classList.add("sheet")
        return
    }
    tooltip.classList.remove("sheet")
    const box = tooltip.getBoundingClientRect()
    const x = Math.min(innerWidth - box.width - 8, Math.max(8, (event?.clientX ?? innerWidth / 2) + 14))
    const below = (event?.clientY ?? 80) + 16
    const y = below + box.height > innerHeight - 8 ? Math.max(8, (event?.clientY ?? 80) - box.height - 12) : below
    tooltip.style.left = `${x}px`
    tooltip.style.top = `${y}px`
}

// With a mouse a tip lasts while the pointer is on its node, edge or value, or on the tip itself, pinned or not;
// on touch (no hover) a tapped tip stays until the next tap.
let touched = false
addEventListener("pointerdown", (event) => (touched = event.pointerType === "touch"), true)
function hideTip() {
    if (app.pinned && touched) {
        return
    }
    setTimeout(() => {
        if (!tooltip.matches(":hover")) {
            app.pinned = null
            tooltip.hidden = true
            graph.highlight()
        }
    }, 120)
}
tooltip.addEventListener("pointerleave", (event) => event.pointerType !== "touch" && hideTip())

function detailsFor(target) {
    const step = shownStep()
    if (target.type === "node") {
        return nodeDetails(app.model, target.id, step)
    }
    if (target.type === "edge") {
        return edgeDetails(app.model, target.id, step)
    }
    return valueDetails(app.model, target.id, step, app.modules)
}

const graph = new GraphView($("#graph"), {
    onHover: (target, event) => {
        if (!app.pinned && event.pointerType !== "touch") {
            showTip(detailsFor(target), event)
        }
    },
    onLeave: hideTip,
    onTap: (target, event) => {
        if (!target) {
            app.pinned = null
            tooltip.hidden = true
            graph.highlight()
            return
        }
        app.pinned = target
        showTip(detailsFor(target), event, true)
    },
})

const panel = new BlackboardPanel($("#blackboard-body"), {
    onEdit: async (key, value) => {
        try {
            await api.setValue(app.moduleId, key, value)
            toast(`set ${key}`)
        } catch (error) {
            toast(`could not set ${key}: ${error.message}`, "danger")
        }
    },
    onPick: (edges, nodes) => {
        graph.highlight(edges, nodes)
        toast(edges.length ? "transitions that write it are outlined" : "the node that writes it is outlined")
    },
})

const timeline = new Timeline($("#timeline"), app.history, {
    onSeek: (index, animate) => render(animate ? "step" : "jump"),
})

// A pill anywhere (blackboard, tooltips) shows its value on hover, or on tap.
let pillTip = null
document.addEventListener("pointerover", (event) => {
    const pill = event.target.closest?.(".pill[data-key]")
    if (!pill || !app.model || event.pointerType === "touch") {
        return
    }
    pillTip?.remove()
    pillTip = document.createElement("div")
    pillTip.className = "pill-tip"
    pillTip.append(valueDetails(app.model, pill.dataset.key, shownStep(), app.modules))
    document.body.append(pillTip)
    const box = pill.getBoundingClientRect()
    const tip = pillTip.getBoundingClientRect()
    pillTip.style.left = `${Math.max(8, Math.min(innerWidth - tip.width - 8, box.left))}px`
    pillTip.style.top = `${box.bottom + 6 + tip.height > innerHeight ? box.top - tip.height - 6 : box.bottom + 6}px`
})
document.addEventListener("pointerout", (event) => {
    if (event.target.closest?.(".pill[data-key]")) {
        pillTip?.remove()
        pillTip = null
        if (app.pinned?.type === "value" && !event.relatedTarget?.closest?.("#tooltip")) {
            hideTip()
        }
    }
})
document.addEventListener("click", (event) => {
    const pill = event.target.closest?.(".pill[data-key]")
    // a blackboard row's own pills open the row instead
    if (pill && app.model && !pill.closest(".bb-line")) {
        event.stopPropagation()
        app.pinned = { type: "value", id: pill.dataset.key }
        pillTip?.remove()
        showTip(valueDetails(app.model, pill.dataset.key, shownStep(), app.modules), event, true)
    }
}, true)
$("#tooltip-close").addEventListener("click", () => {
    app.pinned = null
    tooltip.hidden = true
})

function toast(text, kind = "info") {
    const element = document.createElement("div")
    element.className = `toast toast-${kind}`
    element.textContent = text
    $("#toasts").append(element)
    setTimeout(() => element.remove(), 3200)
}

// ---------------------------------------------------------------------------------------------- layout controls
const body = document.body
function setPanel(open) {
    body.classList.toggle("panel-open", open)
    $("#toggle-panel").setAttribute("aria-pressed", String(open))
    try {
        localStorage.setItem("dim-orchestrator.panel", open ? "1" : "0")
    } catch {
        // no storage
    }
}
let panelPref = null
try {
    panelPref = localStorage.getItem("dim-orchestrator.panel")
} catch {
    // no storage
}
setPanel(panelPref == null ? innerWidth >= 700 : panelPref === "1")
$("#toggle-panel").addEventListener("click", () => setPanel(!body.classList.contains("panel-open")))
$("#close-panel").addEventListener("click", () => setPanel(false))
const source = new SourceView($("#graph"), {
    onApply: async (text) => {
        const problems = await api.setSource(app.moduleId, text)
        if (!problems.length) {
            toast("Applied: the orchestrator restarted on the new file")
            // the journal starts over at 1: reconnect now rather than at the next poll
            app.generation++
            run()
        }
        return problems
    },
})
for (const format of ["toml", "yaml"]) {
    $(`#show-${format}`).addEventListener("click", () => {
        source.show(source.open && source.format === format ? null : format)
        for (const other of ["toml", "yaml"]) {
            $(`#show-${other}`).setAttribute("aria-pressed", String(source.open && source.format === other))
        }
    })
}
// which layout and edge style the graph uses (a ?layout= in the address wins, then the last one picked)
const layoutPicker = $("#layout-style")
layoutPicker.replaceChildren(...Object.entries(LAYOUT_STYLES).map(([value, label]) => Object.assign(document.createElement("option"), { value, textContent: label })))
let pickedLayout = new URLSearchParams(location.search).get("layout")
try {
    pickedLayout ??= localStorage.getItem("dim-orchestrator.layout")
} catch {
    // no storage
}
graph.style = pickedLayout in LAYOUT_STYLES ? pickedLayout : "curves"
layoutPicker.value = graph.style
layoutPicker.addEventListener("change", () => {
    graph.setStyle(layoutPicker.value)
    try {
        localStorage.setItem("dim-orchestrator.layout", layoutPicker.value)
    } catch {
        // no storage
    }
})
$("#fit").addEventListener("click", () => {
    graph.userMoved = false
    graph.fit()
})

// ---------------------------------------------------------------------------------------------- rendering
function shownStep() {
    const steps = app.history.steps
    return timeline.index == null ? steps.at(-1) : steps[timeline.index]
}

/**
 * Show the current step. "live" and "step" animate what changed since the step shown before; "jump" does not.
 * @param {"live" | "step" | "jump"} mode
 */
addEventListener("visibilitychange", () => {
    if (!document.hidden) {
        render("jump")
    }
})

/** The active nodes once `effect` (a transition) is taken: its node's subtree left, its target and that target's
 * ancestors and entry nodes entered. */
function activeAfter(model, active, effect) {
    const inside = (id, root) => {
        for (let at = id; at != null; at = model.nodes.get(at)?.parent) {
            if (at === root) {
                return true
            }
        }
        return false
    }
    const next = new Set(active.filter((id) => !inside(id, effect.node)))
    let at = effect.goto
    if (!model.nodes.has(at)) {
        return [...next]
    }
    for (let up = at; up != null; up = model.nodes.get(up)?.parent) {
        next.add(up)
    }
    while (model.nodes.get(at)?.def?.initial) {
        at = model.nodes.get(at).def.initial
        next.add(at)
    }
    return [...next]
}

function render(mode) {
    const step = shownStep()
    if (!step || !app.model) {
        return
    }
    const steps = app.history.steps
    // A hidden tab holds its animations back and plays them all at once when shown again, so while hidden it only jumps.
    const animate = mode !== "jump" && !document.hidden
    let recent = step
    for (let i = steps.indexOf(step); i >= 0; i--) {
        if (steps[i].effects.some((effect) => effect.kind === "transition" || effect.kind === "fault")) {
            recent = steps[i]
            break
        }
    }
    // one frame per step since the last one shown: the graph plays them in order, each edge then the nodes it lit
    const frames = []
    if (animate) {
        const from = steps.findIndex((s) => s.seq > app.shownSeq)
        const to = steps.indexOf(step)
        const between = from < 0 || from > to ? [] : steps.slice(from, to + 1)
        let before = new Set(steps[Math.max(0, from - 1)]?.active ?? [])
        for (const s of between) {
            const transitions = s.effects.filter((effect) => effect.kind === "transition")
            // Several transitions in one engine step (an `after` into a node whose `always` leaves at once) still play
            // one by one: each but the last lights where it landed, the last shows the step as recorded.
            let active = [...before]
            transitions.forEach((effect, index) => {
                const last = index === transitions.length - 1
                const shown = last ? s : { ...s, active: (active = activeAfter(app.model, active, effect)) }
                const fired = [edgeForRecord(app.model, effect)?.id].filter(Boolean)
                frames.push({ step: shown, fired, entered: shown.active.filter((id) => !before.has(id)) })
                before = new Set(shown.active)
            })
            if (!transitions.length) {
                frames.push({ step: s, fired: [], entered: s.active.filter((id) => !before.has(id)) })
            }
            before = new Set(s.active)
        }
        // a step's changes flash on the blackboard as a whole, so a burst of steps flashes the union
        if (between.length > 1) {
            const changed = Object.assign({}, ...between.map((s) => s.changed))
            panel.show({ ...step, changed, removed: between.flatMap((s) => s.removed) }, true, app.modules, recent)
        } else {
            panel.show(step, true, app.modules, recent)
        }
    } else {
        panel.show(step, false, app.modules, recent)
    }
    graph.show(step, animate ? { frames } : {})
    app.shownSeq = step.seq
    panel.setEditable(timeline.index == null && app.status === "connected" && !app.readOnly)
    timeline.draw(Date.now() / 1000 + app.clockOffset)
    const rewound = timeline.index != null
    body.classList.toggle("rewound", rewound)
    $("#fault").hidden = !app.history.steps.slice(0, steps.indexOf(step) + 1).some((s) => s.effects.some((e) => e.kind === "fault"))
    if (app.pinned) {
        showTip(detailsFor(app.pinned), null, true)
    }
}

function tickTimers() {
    if (app.model && timeline.index == null) {
        graph.drawTimers(Date.now() / 1000 + app.clockOffset)
        timeline.draw(Date.now() / 1000 + app.clockOffset)
    }
    requestAnimationFrame(tickTimers)
}
requestAnimationFrame(tickTimers)

// ---------------------------------------------------------------------------------------------- connection
function setStatus(status, detail = "") {
    app.status = status
    const chip = $("#status")
    chip.dataset.status = status
    chip.textContent = {
        searching: "looking for an orchestrator…",
        "gateway-down": "dimos gateway unreachable",
        none: "no orchestrator running",
        connecting: "connecting…",
        connected: "live",
        stopped: "orchestrator stopped",
    }[status]
    chip.title = detail
    source.setEditable(status === "connected" && !app.readOnly)
    const empty = $("#empty")
    const showEmpty = !app.model && status !== "connected"
    empty.hidden = !showEmpty
    $("#empty-detail").textContent = status === "gateway-down" ? `The dimos gateway did not answer${detail ? `: ${detail}` : ""}.` : "Start a blueprint with an Orchestrator module, e.g."
    panel.setEditable?.(status === "connected" && !app.readOnly && timeline.index == null)
}

function fillPicker(orchestrators) {
    const picker = $("#picker")
    const ids = orchestrators.map((o) => o.id)
    picker.hidden = ids.length < 2
    if (picker.dataset.ids !== ids.join(",")) {
        picker.dataset.ids = ids.join(",")
        picker.replaceChildren(...ids.map((id) => Object.assign(document.createElement("option"), { value: id, textContent: id })))
    }
    picker.value = app.moduleId ?? ids[0]
}
$("#picker").addEventListener("change", (event) => {
    app.wanted = event.target.value
    app.generation++
    run()
})

async function discover() {
    while (true) {
        try {
            app.modules = await api.runningModules()
        } catch (error) {
            // a gateway that can't list the run (down, or from an older checkout than the run's) still leaves the
            // orchestrator_state topic, which needs only Desktop's zenoh-gateway
            console.warn("the dimos gateway can't list modules; following orchestrator_state:", error.message)
            app.modules = []
            return "orchestrator"
        }
        const orchestrators = api.orchestratorsIn(app.modules)
        fillPicker(orchestrators)
        if (orchestrators.length) {
            return (orchestrators.find((o) => o.id === app.wanted) ?? orchestrators[0]).id
        }
        setStatus(app.model ? "stopped" : "none")
        await wait(SEARCH_S)
    }
}

/** Draw a new file: the graph, the panel and an empty history. */
function showFile(definition, file) {
    app.model = buildModel(definition)
    app.file = file
    $("#file").textContent = file.split("/").pop()
    $("#file").title = file
    app.history.steps = []
    app.history.faulted = false
    app.shownSeq = 0
    graph.setModel(app.model)
    panel.setModel(app.model)
    timeline.goLive()
}

/** One orchestrator_state message as a journal step, its blackboard diffed against the step before. */
function stateEntry(message, before, time) {
    const constants = message.definition.constants ?? {}
    const blackboard = before ? message.blackboard ?? {} : { ...constants, ...message.blackboard }
    const previous = before?.blackboard ?? {}
    return {
        seq: message.seq,
        time,
        item: { kind: before ? "step" : "joined", handled: message.handled },
        effects: [
            ...(message.transitions ?? []).map((transition) => ({ kind: "transition", ...transition })),
            ...(message.fault ? [{ kind: "fault", ...message.fault }] : []),
        ],
        changed: Object.fromEntries(Object.entries(blackboard).filter(([key, value]) => JSON.stringify(previous[key]) !== JSON.stringify(value))),
        removed: Object.keys(previous).filter((key) => !(key in blackboard) && !(key in constants)),
        active: message.active ?? [],
        calls: (message.calls ?? []).map((call, index) => ({ id: index, uses: [], ...call })),
        timers: (message.timers ?? []).map((timer) => ({ ...timer, due: time + timer.due_in_s })),
        outcomes: [],
    }
}

/** Follow an orchestrator without the journal RPCs through its orchestrator_state topic: view only. */
async function followStream(moduleId, generation) {
    setStatus("connecting")
    const queue = []
    let wake = null
    const unsubscribe = await api.watchState((message) => {
        queue.push(message)
        wake?.()
    })
    try {
        let caughtUp = false
        while (generation === app.generation) {
            if (!queue.length) {
                // a message wakes it; the timeout lets a picked orchestrator or a restart be noticed
                await new Promise((resolve) => {
                    wake = resolve
                    setTimeout(resolve, SEARCH_S * 1000)
                })
                wake = null
                continue
            }
            const message = queue.shift()
            const history = app.history
            if (!app.model || app.moduleId !== moduleId || message.seq < history.seq || JSON.stringify(app.model.definition) !== JSON.stringify(message.definition)) {
                showFile(message.definition, `${moduleId} (orchestrator_state)`)
                app.moduleId = moduleId
                app.clockOffset = 0
                source.setSource(app.file, "")
                source.setNames(namesFor(app.model, {}))
                setStatus("connected")
                caughtUp = false
            }
            const added = history.add([stateEntry(message, history.last, Date.now() / 1000)])
            if (added.length && timeline.index == null) {
                render(caughtUp && !queue.length ? "live" : "jump")
            } else if (added.length) {
                timeline.draw()
            }
            caughtUp ||= !queue.length
        }
    } finally {
        unsubscribe()
    }
}

async function follow(moduleId, generation) {
    // ?stream follows the stream even where the journal RPCs exist, to try that mode
    app.readOnly = new URLSearchParams(location.search).has("stream") || !api.hasJournal(app.modules.find((module) => module.id === moduleId))
    if (app.readOnly) {
        return followStream(moduleId, generation)
    }
    setStatus("connecting")
    const found = await api.getDefinition(moduleId)
    const snapshot = await api.getState(moduleId)
    app.clockOffset = (snapshot.time ?? Date.now() / 1000) - Date.now() / 1000
    const sameFile = app.model && JSON.stringify(app.model.definition) === JSON.stringify(found.definition) && app.moduleId === moduleId
    const history = app.history
    let first = await api.getJournal(moduleId, 0)
    const restarted = history.steps.length && (first.seq < history.seq || first.entries[0]?.time !== history.steps[0]?.time)
    if (!sameFile || restarted) {
        showFile(found.definition, found.file)
    }
    app.moduleId = moduleId
    source.setSource(found.file, found.source)
    source.setNames(namesFor(app.model, {}))
    if (!history.steps.length && first.oldest > 1) {
        history.seed(snapshot)
        first = await api.getJournal(moduleId, snapshot.seq)
    }
    setStatus("connected")
    let entries = first.entries
    let more = entries.length > 0
    // the steps from before we connected (a reload, a reconnect) are history: show where they ended, don't play them
    let caughtUp = false
    while (generation === app.generation) {
        const added = history.add(entries)
        if (added.length && timeline.index == null) {
            render(caughtUp ? "live" : "jump")
        } else if (added.length) {
            timeline.draw()
        }
        if (!more) {
            await wait(POLL_S)
        }
        const page = await api.getJournal(moduleId, history.seq)
        if (page.seq < history.seq) {
            throw new Error("the orchestrator restarted")
        }
        caughtUp ||= !more
        entries = page.entries
        more = page.entries.length > 0 && page.entries.at(-1).seq < page.seq
    }
}

async function run() {
    const generation = app.generation
    while (generation === app.generation) {
        const moduleId = await discover()
        if (generation !== app.generation) {
            return
        }
        try {
            await follow(moduleId, generation)
        } catch (error) {
            console.warn("lost the orchestrator:", error)
            setStatus("stopped", error.message)
            render("jump")
            await wait(SEARCH_S)
        }
    }
}

setStatus("searching")
await celReady
const preview = new URLSearchParams(location.search).get("preview")
if (preview) {
    // Draw a definition from a JSON file with nothing running, to check how a file lays out.
    const definition = await (await fetch(preview)).json()
    app.model = buildModel(definition)
    graph.setModel(app.model)
    panel.setModel(app.model)
    app.history.add([{ seq: 1, time: Date.now() / 1000, item: { kind: "startup" }, effects: [], changed: { ...definition.constants, ...definition.vars }, removed: [], active: [definition.root], calls: [], timers: [], outcomes: [] }])
    $("#file").textContent = preview.split("/").pop()
    setStatus("stopped", "preview")
    render("jump")
} else {
    run()
}
