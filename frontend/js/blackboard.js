// The blackboard as a table on the right: keys grouped by where they come from, values as colored JSON, rows that a
// step changed flashing, and links to whatever writes each key.

import { renderCel } from "./cel.js"
import { h, namesFor, publisherOf, renderJson } from "./details.js"
import { groupOf } from "./model.js"

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

    addRow(group, key, event) {
        const model = this.model
        const value = h("div", { class: "bb-value" })
        const links = h("div", { class: "bb-links" })
        const signal = model.signals.get(key)
        if (signal) {
            links.append(h("span", { class: "bb-link", title: "the stream this signal reads" }, "⟵ ", h("code", {}, signal.stream + (signal.field ? `.${signal.field}` : ""))))
        }
        if (model.results.has(key)) {
            const nodes = model.results.get(key)
            links.append(h("button", { class: "bb-link", type: "button", onclick: () => this.handlers.onPick([], nodes) }, "⟵ ", nodes.join(", ")))
        }
        if (model.setters.has(key)) {
            const edges = model.setters.get(key)
            links.append(h("button", { class: "bb-link", type: "button", onclick: () => this.handlers.onPick(edges, []) }, `⟵ set by ${edges.length} transition${edges.length > 1 ? "s" : ""}`))
        }
        const editButton = group === "signals" || group === "vars"
            ? h("button", { class: "bb-edit", type: "button", title: `set ${key}`, onclick: () => this.edit(key) }, "✎")
            : null
        const names = namesFor(model, {})
        const element = h(
            "div",
            { class: "bb-row", "data-key": key },
            h("div", { class: "bb-key" }, h("span", { class: `pill pill-${names.kindOf(key)}`, "data-key": key }, key), editButton),
            value,
            links,
        )
        if (event) {
            value.append(renderCel(event.when, namesFor(model, {})))
        }
        this.sections.get(group).body.append(element)
        this.rows.set(key, { element, value, group, last: undefined })
        this.updateCount(group)
        return this.rows.get(key)
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
                row.value.replaceChildren(h("pre", { class: "bb-json" }, renderJson(value)))
            }
            row.element.classList.remove("unset")
        }
        for (const [key, row] of this.rows) {
            if (row.group !== "events" && !(key in step.blackboard) && !row.editing) {
                row.element.classList.add("unset")
                row.last = undefined
                row.value.replaceChildren(h("span", { class: "j-null" }, "unset"))
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
        row.value.replaceChildren(h("div", { class: "bb-editor" }, input, send))
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
