// The blackboard as a table on the right: keys grouped by where they come from, values as colored JSON, rows that a
// step changed flashing, and links to whatever writes each key.

import { h, namesFor, publisherOf, renderJsonLine } from "./details.js"
import { fitLists, renderFriendly } from "./friendly.js"
import { edgeLabel } from "./graph.js"
import { groupOf } from "./model.js"

/** The transitions whose `if` or `after` reads `key` (directly, or a field of it). */
/** Matches `key` as a whole name in an expression (not part of a longer one). */
const readsKey = (key) => new RegExp(`(^|[^\\w.])${key.replace(/[.]/g, "\\.")}($|[^\\w])`)

function usersOf(model, key) {
    const reads = readsKey(key)
    return model.edges
        .filter((edge) => edge.transition)
        .filter(({ transition }) => [transition.if, transition.after].some((source) => source != null && reads.test(String(source))))
        .map((edge) => edge.id)
}

/** Which of `names` a node (or anything inside it) reads, sets or returns. */
function usedBy(model, id, names) {
    const inside = (nodeId) => {
        for (let at = nodeId; at != null; at = model.nodes.get(at)?.parent) {
            if (at === id) {
                return true
            }
        }
        return false
    }
    const sources = []
    const keys = new Set()
    for (const node of model.nodes.values()) {
        if (node.def && inside(node.id)) {
            sources.push(JSON.stringify([node.def.args, node.def.requires, node.def.ensures]))
            if (node.def.result) {
                keys.add(node.def.result)
            }
        }
    }
    for (const edge of model.edges) {
        if (edge.transition && inside(edge.from)) {
            sources.push(String(edge.transition.if ?? ""), String(edge.transition.after ?? ""))
            Object.keys(edge.transition.set ?? {}).forEach((key) => keys.add(key))
            sources.push(JSON.stringify(Object.values(edge.transition.set ?? {})))
        }
    }
    const text = sources.join("\n")
    for (const key of names) {
        if (readsKey(key).test(text)) {
            keys.add(key)
        }
    }
    return keys
}

/** How many decimals a number shows (at most 4, as values are drawn elsewhere). */
const decimals = (value) => (Number.isInteger(value) ? 0 : Math.min(4, String(+value.toFixed(4)).split(".")[1]?.length ?? 0))

/** A row's number with as many decimals as the row has needed so far (0.3, 0.125, then 0.350, 0.300). */
const steadyNumber = (row) => h("span", { class: "j-num" }, row.value.toFixed(row.digits ?? 0))

const GROUPS = [
    ["streams", "Stream values", "a field of the latest message on a stream"],
    ["vars", "Vars", "written by transitions' `set`"],
    ["results", "Results", "what activities returned"],
    ["other", "Other", ""],
    ["constants", "Constants", "fixed by the file"],
]

export class BlackboardPanel {
    /**
     * @param {HTMLElement} container
     * @param {{ onPick: (edgeIds: string[], nodeIds: string[]) => void, onTip: (content: Node, event: PointerEvent) => void, onLeaveTip: () => void }} handlers
     */
    constructor(container, handlers) {
        this.container = container
        this.handlers = handlers
        this.rows = new Map()
        this.collapsed = new Set(["constants"])
        this.expanded = new Set()
    }

    setModel(model) {
        this.model = model
        this.rows.clear()
        this.container.replaceChildren()
        this.sections = new Map()
        this.flight = h("div", { class: "bb-flight" })
        this.container.append(this.flight)
        for (const [id, title, note] of GROUPS) {
            const body = h("div", { class: "bb-body" })
            const head = h(
                "button",
                { class: "bb-group-head", type: "button", onclick: () => this.toggle(id) },
                h("span", { class: "bb-caret" }, "▾"),
                h("span", { class: "bb-group-title" }, title),
                h("span", { class: "bb-count" }),
                h("span", { class: "bb-note" }, note),
            )
            const section = h("section", { class: `bb-group bb-${id}` }, head, body)
            section.classList.toggle("collapsed", this.collapsed.has(id))
            this.sections.set(id, { section, body, head })
            this.container.append(section)
        }
        GROUPS.forEach(([id]) => this.updateCount(id))
        this.interface = null
        this.rpcList = this.listSection("rpcs", "RPCs", "what the file calls: hover for its docstring")
        this.streamList = this.listSection("stream-list", "Streams", "what the file listens to")
    }

    /** A collapsible section that isn't blackboard keys: the RPCs or the streams. */
    listSection(id, title, note) {
        const body = h("div", { class: "bb-body" })
        const count = h("span", { class: "bb-count" })
        const section = h(
            "section",
            { class: `bb-group bb-${id}`, hidden: "" },
            h("button", { class: "bb-group-head", type: "button", onclick: () => section.classList.toggle("collapsed") }, h("span", { class: "bb-caret" }, "▾"), h("span", { class: "bb-group-title" }, title), count, h("span", { class: "bb-note" }, note)),
            body,
        )
        this.container.append(section)
        return { section, body, count }
    }

    /** The RPCs the file calls (with their signature and docstring) and the streams it reads (with their message type),
     * from the orchestrator_state message. */
    setInterface(rpcs, streams) {
        const text = JSON.stringify([rpcs, streams])
        if (!this.model || this.interface === text) {
            return
        }
        this.interface = text
        const model = this.model
        const nodesRunning = (rpc) => {
            const uses = []
            for (const activity of model.activities.values()) {
                const as = activity.start === rpc ? "start" : activity.cancel === rpc ? "cancel" : null
                if (as) {
                    for (const node of model.definition.nodes.filter((n) => n.activity === activity.name)) {
                        uses.push({ node: node.name, as })
                    }
                }
            }
            return uses
        }
        const fill = ({ section, body, count }, rows) => {
            body.replaceChildren(...rows)
            count.textContent = String(rows.length)
            section.hidden = rows.length === 0
        }
        fill(this.rpcList, Object.entries(rpcs).sort(([a], [b]) => a.localeCompare(b)).map(([name, info]) => {
            const uses = nodesRunning(name)
            const tip = () => h("div", { class: "rpc-tip" }, h("code", { class: "rpc-sig" }, `${name}${(info.signature ?? "(…)").replace(/^\(self,?\s*/, "(")}`), h("div", { class: "rpc-doc" }, info.doc?.trim().split(/\n\s*\n/).map((paragraph) => paragraph.replace(/\s*\n\s*/g, " ")).join("\n\n") || "No docstring."))
            return h(
                "div",
                {
                    class: "bb-list-row", "data-rpc": name,
                    onpointerenter: (event) => event.pointerType !== "touch" && this.handlers.onTip(tip(), event),
                    onpointerleave: (event) => event.pointerType !== "touch" && this.handlers.onLeaveTip(),
                    onclick: (event) => {
                        this.handlers.onPick([], uses.map((use) => use.node))
                        this.handlers.onTip(tip(), event)
                    },
                },
                h("code", { class: "bb-list-name" }, name),
                h("span", { class: "bb-list-uses" }, ...uses.map((use) => h("span", { class: `bb-use ${use.as}` }, use.as === "cancel" ? `${use.node} (cancel)` : use.node))),
            )
        }))
        fill(this.streamList, Object.entries(streams).sort(([a], [b]) => a.localeCompare(b)).map(([stream, type]) => {
            const values = [...model.streamValues.values()].filter((value) => value.stream === stream)
            const triggers = model.edges.filter((edge) => edge.transition?.on === stream).map((edge) => edge.id)
            const names = namesFor(model, {})
            return h(
                "div",
                { class: "bb-list-row", onclick: () => triggers.length && this.handlers.onPick(triggers, []) },
                h("code", { class: "bb-list-name" }, stream),
                h("span", { class: "bb-list-type" }, type),
                h(
                    "span",
                    { class: "bb-list-uses" },
                    ...values.map((value) => h("span", { class: `pill pill-${names.kindOf(value.name)}`, "data-key": value.name, title: `.${value.field}` }, value.name)),
                    triggers.length ? h("span", { class: "bb-use" }, `on: ${triggers.length} transition${triggers.length > 1 ? "s" : ""}`) : null,
                ),
            )
        }))
    }

    /** While a call is out, its RPC's row says so. */
    showCalls(step) {
        const out = new Set(step.calls.map((call) => call.rpc))
        for (const row of this.rpcList?.body.children ?? []) {
            row.classList.toggle("busy", out.has(row.dataset.rpc))
        }
    }

    toggle(id) {
        const { section } = this.sections.get(id)
        section.classList.toggle("collapsed")
        if (section.classList.contains("collapsed")) {
            this.collapsed.add(id)
        } else {
            this.collapsed.delete(id)
        }
    }

    // A row is one fixed-height line (key and a one-line preview) until it is clicked. Expanded, the preview gives way
    // to a fixed-height, scrolling box: where the key comes from and which transitions use it on the left, the full
    // value on the right. Live updates never change the panel's layout.
    addRow(group, key) {
        const model = this.model
        const preview = h("div", { class: "bb-preview" })
        const full = h("div", { class: "bb-full" })
        const sources = h("div", { class: "bb-sources" })
        const list = (title, items) => {
            if (items.length) {
                sources.append(h("div", { class: "bb-src-title" }, title), ...items)
            }
        }
        const transition = (edgeId) => {
            const edge = model.edgeById.get(edgeId)
            return h(
                "button",
                { class: "bb-src", type: "button", onclick: (click) => {
                    click.stopPropagation()
                    this.handlers.onPick([edgeId], [])
                } },
                h("span", { class: "bb-src-line" }, h("span", { class: "bb-src-node" }, edge.from), h("span", { class: "bb-src-arrow" }, " → "), edge.transition?.goto ?? edge.to),
                h("span", { class: "bb-src-when" }, edgeLabel(edge)),
            )
        }
        const streamValue = model.streamValues.get(key)
        if (streamValue) {
            list("read from", [h("code", { class: "bb-src" }, `${streamValue.stream}.${streamValue.field}`)])
        }
        const resultOf = model.results.get(key) ?? []
        list("result of", resultOf.map((node) => h("button", { class: "bb-src", type: "button", onclick: (click) => {
            click.stopPropagation()
            this.handlers.onPick([], [node])
        } }, h("span", { class: "bb-src-node" }, node))))
        list("set by", (model.setters.get(key) ?? []).map(transition))
        const users = usersOf(model, key)
        sources.append(h("div", { class: "bb-src-title" }, "Transitions"), ...(users.length ? users.map(transition) : [h("span", { class: "bb-src-none" }, "None")]))
        const names = namesFor(model, {})
        const line = h(
            "div",
            { class: "bb-line", onclick: () => this.toggleRow(key) },
            h("span", { class: "bb-row-caret" }, "▸"),
            h("span", { class: "bb-key" }, h("span", { class: `pill pill-${names.kindOf(key)}`, "data-key": key }, key)),
            preview,
        )
        const element = h("div", { class: "bb-row", "data-key": key }, line, h("div", { class: "bb-detail" }, sources, full))
        element.classList.toggle("unused", this.used != null && !this.used.has(key))
        this.sections.get(group).body.append(element)
        const row = { element, preview, full, group, last: undefined, value: undefined }
        this.rows.set(key, row)
        element.classList.toggle("expanded", this.expanded.has(key))
        this.updateCount(group)
        return row
    }

    /** While a node is hovered (or clicked), only the names it uses keep their color; null brings them all back. */
    focus(nodeId) {
        this.used = nodeId == null || !this.model ? null : usedBy(this.model, nodeId, this.rows.keys())
        for (const [key, row] of this.rows) {
            row.element.classList.toggle("unused", this.used != null && !this.used.has(key))
        }
    }

    toggleRow(key) {
        const row = this.rows.get(key)
        if (!row) {
            return
        }
        const open = !this.expanded.has(key)
        if (open) {
            this.expanded.add(key)
        } else {
            this.expanded.delete(key)
        }
        row.element.classList.toggle("expanded", open)
        this.drawFull(row)
    }

    /** The full value, drawn only while the row is open. */
    drawFull(row) {
        if (!row.element.classList.contains("expanded") || row.drawn === row.last) {
            return
        }
        row.drawn = row.last
        // a list or an object takes the box's full width, with what writes and reads it below
        row.element.classList.toggle("wide", row.value !== null && typeof row.value === "object")
        row.full.replaceChildren(row.last == null ? h("span", { class: "fj-empty" }, "unset") : typeof row.value === "number" ? steadyNumber(row) : renderFriendly(row.value))
        requestAnimationFrame(() => fitLists(row.full))
    }

    updateCount(group) {
        const { body, head } = this.sections.get(group)
        head.querySelector(".bb-count").textContent = String(body.children.length)
        this.sections.get(group).section.hidden = body.children.length === 0
    }

    /**
     * @param {import("./history.js").Step} step
     * @param {boolean} flash whether to flash the rows this step changed
     */
    show(step, flash, modules, recent) {
        this.recent = recent
        if (!this.model || !step) {
            return
        }
        this.step = step
        this.modules = modules
        for (const [key, value] of Object.entries(step.blackboard)) {
            let row = this.rows.get(key)
            if (!row) {
                row = this.addRow(groupOf(this.model, key), key)
            }
            const text = JSON.stringify(value)
            if (row.last !== text) {
                row.last = text
                row.value = value
                if (typeof value === "number") {
                    // the most decimals this key has shown so far, so its decimal point stays put as it changes
                    row.digits = Math.max(row.digits ?? 0, decimals(value))
                    row.preview.replaceChildren(steadyNumber(row))
                } else {
                    row.preview.replaceChildren(renderJsonLine(value))
                }
                this.drawFull(row)
            }
            row.element.classList.remove("unset")
        }
        for (const [key, row] of this.rows) {
            if (!(key in step.blackboard) && row.last !== null) {
                row.element.classList.add("unset")
                row.last = null // drawn as unset (undefined: not drawn yet)
                row.value = undefined
                row.preview.replaceChildren(h("span", { class: "j-null" }, "unset"))
                this.drawFull(row)
            }
        }
        if (flash) {
            for (const key of [...Object.keys(step.changed), ...step.removed]) {
                const row = this.rows.get(key)
                if (row) {
                    row.element.classList.remove("changed")
                    void row.element.offsetWidth
                    row.element.classList.add("changed")
                }
            }
        }
        this.showFlight(step, flash)
        this.showCalls(step)
    }

    /** The calls under way and the latest transition, above the groups. */
    showFlight(step, flash) {
        const transitions = (this.recent ?? step).effects.filter((effect) => effect.kind === "transition")
        const faults = step.effects.filter((effect) => effect.kind === "fault")
        const calls = step.calls.map((call) =>
            h("div", { class: `bb-call ${call.kind} ${call.phase}` }, h("span", { class: "bb-call-kind" }, call.phase === "held" ? "held" : call.kind), h("code", {}, call.rpc), call.node ? h("span", { class: "bb-call-node" }, call.node) : null)
        )
        const latest = transitions.at(-1)
        const banner = latest
            ? h("div", { class: "bb-latest" }, h("span", { class: "bb-latest-from" }, latest.node), " → ", h("strong", {}, latest.goto), h("span", { class: "bb-latest-cause" }, latest.cause ?? "else"))
            : null
        const fault = faults.length ? h("div", { class: "bb-fault" }, `fault in ${faults[0].node}: ${faults[0].rule}`) : null
        this.flight.replaceChildren(...[fault, banner, calls.length ? h("div", { class: "bb-calls" }, ...calls) : null].filter(Boolean))
        if (flash && (step.effects.some((effect) => effect.kind === "transition") || fault)) {
            this.flight.classList.remove("changed")
            void this.flight.offsetWidth
            this.flight.classList.add("changed")
        }
    }

    publisher(key) {
        const streamValue = this.model.streamValues.get(key)
        return streamValue ? publisherOf(this.modules, streamValue.stream) : null
    }
}
