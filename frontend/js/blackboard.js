// The blackboard as a table on the right: keys grouped by where they come from, values as colored JSON, rows that a
// step changed flashing, and links to whatever writes each key.

import { renderCel } from "./cel.js"
import { h, namesFor, publisherOf, renderJsonLine } from "./details.js"
import { fitLists, renderFriendly } from "./friendly.js"
import { edgeLabel } from "./graph.js"
import { groupOf } from "./model.js"

/** The transitions whose `on`, `if` or `after` reads `key` (directly, or a field of it). */
function usersOf(model, key) {
    const reads = new RegExp(`(^|[^\\w.])${key.replace(/[.]/g, "\\.")}($|[^\\w])`)
    return model.edges
        .filter((edge) => edge.transition)
        .filter(({ transition }) => transition.on === key || [transition.if, transition.after].some((source) => source != null && reads.test(String(source))))
        .map((edge) => edge.id)
}

/** How many decimals a number shows (at most 4, as values are drawn elsewhere). */
const decimals = (value) => (Number.isInteger(value) ? 0 : Math.min(4, String(+value.toFixed(4)).split(".")[1]?.length ?? 0))

/** A row's number with as many decimals as the row has needed so far (0.3, 0.125, then 0.350, 0.300). */
const steadyNumber = (row) => h("span", { class: "j-num" }, row.value.toFixed(row.digits ?? 0))

const GROUPS = [
    ["signals", "Signals", "read from streams"],
    ["vars", "Vars", "written by transitions' `set`"],
    ["results", "Results", "what activities returned"],
    ["other", "Other", ""],
    ["events", "Events", "named conditions, true when their `when` is"],
    ["constants", "Constants", "fixed by the file"],
]

export class BlackboardPanel {
    /**
     * @param {HTMLElement} container
     * @param {{ onEdit: (key: string, value: any) => Promise<void>, onPick: (edgeIds: string[], nodeIds: string[]) => void }} handlers
     */
    constructor(container, handlers) {
        this.container = container
        this.handlers = handlers
        this.rows = new Map()
        this.collapsed = new Set(["constants"])
        this.expanded = new Set()
        this.editable = false
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
        for (const [name, event] of model.events) {
            this.addRow("events", name, event)
        }
        GROUPS.forEach(([id]) => this.updateCount(id))
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
    addRow(group, key, event) {
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
        const signal = model.signals.get(key)
        if (signal) {
            list("read from", [h("code", { class: "bb-src" }, signal.stream + (signal.field ? `.${signal.field}` : ""))])
        }
        const resultOf = model.results.get(key) ?? []
        list("result of", resultOf.map((node) => h("button", { class: "bb-src", type: "button", onclick: (click) => {
            click.stopPropagation()
            this.handlers.onPick([], [node])
        } }, h("span", { class: "bb-src-node" }, node))))
        list("set by", (model.setters.get(key) ?? []).map(transition))
        const users = usersOf(model, key)
        sources.append(h("div", { class: "bb-src-title" }, "Transitions"), ...(users.length ? users.map(transition) : [h("span", { class: "bb-src-none" }, "None")]))
        const editButton = group === "signals" || group === "vars"
            ? h("button", { class: "bb-edit", type: "button", title: `set ${key}`, onclick: (click) => {
                click.stopPropagation()
                this.edit(key)
            } }, "✎")
            : null
        const names = namesFor(model, {})
        const line = h(
            "div",
            { class: "bb-line", onclick: () => this.toggleRow(key) },
            h("span", { class: "bb-row-caret" }, "▸"),
            h("span", { class: "bb-key" }, h("span", { class: `pill pill-${names.kindOf(key)}`, "data-key": key }, key)),
            preview,
            editButton,
        )
        const element = h("div", { class: "bb-row", "data-key": key }, line, h("div", { class: "bb-detail" }, sources, full))
        if (event) {
            preview.append(renderCel(event.when, names))
            full.append(renderCel(event.when, names))
        }
        this.sections.get(group).body.append(element)
        const row = { element, preview, full, group, last: undefined, value: undefined }
        this.rows.set(key, row)
        element.classList.toggle("expanded", this.expanded.has(key))
        this.updateCount(group)
        return row
    }

    toggleRow(key) {
        const row = this.rows.get(key)
        if (!row || row.editing) {
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
        if (row.group === "events" || !row.element.classList.contains("expanded") || row.drawn === row.last) {
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
            if (row.editing) {
                continue
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
            if (row.group !== "events" && !(key in step.blackboard) && !row.editing && row.last !== null) {
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
            ? h("div", { class: "bb-latest" }, h("span", { class: "bb-latest-from" }, latest.node), " → ", h("strong", {}, latest.goto), h("span", { class: "bb-latest-cause" }, latest.cause ?? "always"))
            : null
        const fault = faults.length ? h("div", { class: "bb-fault" }, `fault in ${faults[0].node}: ${faults[0].rule}`) : null
        this.flight.replaceChildren(...[fault, banner, calls.length ? h("div", { class: "bb-calls" }, ...calls) : null].filter(Boolean))
        if (flash && (step.effects.some((effect) => effect.kind === "transition") || fault)) {
            this.flight.classList.remove("changed")
            void this.flight.offsetWidth
            this.flight.classList.add("changed")
        }
    }

    edit(key) {
        const row = this.rows.get(key)
        if (!this.editable || !row || row.editing) {
            return
        }
        row.editing = true
        const current = this.step && key in this.step.blackboard ? JSON.stringify(this.step.blackboard[key]) : ""
        const input = h("input", { class: "bb-input", value: current, spellcheck: "false", "aria-label": `new value of ${key}` })
        const done = () => {
            row.editing = false
            row.last = undefined
            row.drawn = undefined
            this.show(this.step, false, this.modules)
        }
        const submit = async () => {
            let value
            try {
                value = JSON.parse(input.value)
            } catch {
                value = input.value
            }
            input.disabled = true
            try {
                await this.handlers.onEdit(key, value)
            } finally {
                done()
            }
        }
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                submit()
            } else if (event.key === "Escape") {
                done()
            }
        })
        const send = h("button", { class: "bb-send", type: "button", onclick: submit }, "set")
        row.preview.replaceChildren(h("div", { class: "bb-editor", onclick: (click) => click.stopPropagation() }, input, send))
        input.focus()
        input.select()
    }

    setEditable(editable) {
        this.editable = editable
        this.container.classList.toggle("read-only", !editable)
    }

    publisher(key) {
        const signal = this.model.signals.get(key)
        return signal ? publisherOf(this.modules, signal.stream) : null
    }
}
