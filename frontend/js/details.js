// What a hover or tap shows: a node's or an edge's full definition with its live state, a blackboard value, and
// JSON drawn with colors.

import { renderCel } from "./cel.js"
import { RESERVED, groupOf, knownNames } from "./model.js"

export const h = (tag, attrs = {}, ...children) => {
    const element = document.createElement(tag)
    for (const [key, value] of Object.entries(attrs)) {
        if (key === "class") {
            element.className = value
        } else if (key.startsWith("on")) {
            element.addEventListener(key.slice(2), value)
        } else if (value != null) {
            element.setAttribute(key, value)
        }
    }
    element.append(...children.flat().filter((child) => child != null && child !== false))
    return element
}

/** A JSON value as colored, indented DOM. */
export function renderJson(value, indent = 0) {
    const pad = "  ".repeat(indent)
    if (value === null || value === undefined) {
        return h("span", { class: "j-null" }, String(value))
    }
    if (typeof value === "string") {
        return h("span", { class: "j-str" }, JSON.stringify(value))
    }
    if (typeof value === "number") {
        return h("span", { class: "j-num" }, Number.isInteger(value) ? String(value) : String(+value.toFixed(4)))
    }
    if (typeof value === "boolean") {
        return h("span", { class: `j-bool j-${value}` }, String(value))
    }
    const isArray = Array.isArray(value)
    const entries = isArray ? value.map((item, index) => [index, item]) : Object.entries(value)
    if (!entries.length) {
        return h("span", { class: "j-punct" }, isArray ? "[]" : "{}")
    }
    const flat = JSON.stringify(value)
    if (flat.length <= 48) {
        return h("span", {}, ...inline(value))
    }
    const out = [h("span", { class: "j-punct" }, isArray ? "[" : "{"), "\n"]
    entries.forEach(([key, item], index) => {
        out.push(pad + "  ")
        if (!isArray) {
            out.push(h("span", { class: "j-key" }, key), h("span", { class: "j-punct" }, ": "))
        }
        out.push(renderJson(item, indent + 1))
        out.push(index < entries.length - 1 ? h("span", { class: "j-punct" }, ",") : "", "\n")
    })
    out.push(pad, h("span", { class: "j-punct" }, isArray ? "]" : "}"))
    return h("span", {}, ...out)
}

/** A value on one line (colored), cut off with "…" once about `budget` characters are drawn, so a huge value stays cheap. */
export function renderJsonLine(value, budget = 160) {
    let left = budget
    const walk = (item) => {
        if (left <= 0) {
            return []
        }
        if (item === null || typeof item !== "object") {
            left -= JSON.stringify(item ?? null)?.length ?? 4
            return [renderJson(item)]
        }
        const isArray = Array.isArray(item)
        const entries = isArray ? item.map((one, index) => [index, one]) : Object.entries(item)
        const parts = [h("span", { class: "j-punct" }, isArray ? "[" : "{ ")]
        for (const [index, [key, one]] of entries.entries()) {
            if (left <= 0) {
                parts.push(h("span", { class: "j-punct" }, "…"))
                return parts
            }
            if (!isArray) {
                left -= String(key).length + 2
                parts.push(h("span", { class: "j-key" }, key), h("span", { class: "j-punct" }, ": "))
            }
            parts.push(...walk(one))
            if (index < entries.length - 1) {
                parts.push(h("span", { class: "j-punct" }, ", "))
            }
        }
        parts.push(h("span", { class: "j-punct" }, isArray ? "]" : " }"))
        return parts
    }
    return h("span", {}, ...walk(value))
}

function inline(value) {
    if (value === null || typeof value !== "object") {
        return [renderJson(value)]
    }
    const isArray = Array.isArray(value)
    const parts = [h("span", { class: "j-punct" }, isArray ? "[" : "{ ")]
    const entries = isArray ? value.map((item, index) => [index, item]) : Object.entries(value)
    entries.forEach(([key, item], index) => {
        if (!isArray) {
            parts.push(h("span", { class: "j-key" }, key), h("span", { class: "j-punct" }, ": "))
        }
        parts.push(...inline(item))
        if (index < entries.length - 1) {
            parts.push(h("span", { class: "j-punct" }, ", "))
        }
    })
    parts.push(h("span", { class: "j-punct" }, isArray ? "]" : " }"))
    return parts
}

/** Names for CEL pills: what a pill may name, and which group colors it. */
export function namesFor(model, blackboard) {
    return {
        known: knownNames(model, blackboard),
        kindOf: (name) => (RESERVED.includes(name) ? "outcome" : groupOf(model, name)),
    }
}

const row = (label, ...value) => h("div", { class: "d-row" }, h("span", { class: "d-label" }, label), h("span", { class: "d-value" }, ...value))
const mono = (text) => h("code", { class: "d-mono" }, text)

export function nodeDetails(model, id, step) {
    const node = model.nodes.get(id)
    const names = namesFor(model, step?.blackboard)
    const cel = (source) => renderCel(source, names)
    if (node.kind === "start") {
        return h("div", { class: "details" }, h("div", { class: "d-title" }, `${node.parent} starts here`), row("initial", mono(model.nodes.get(node.parent).def.initial)))
    }
    if (node.kind === "final") {
        return h(
            "div",
            { class: "details" },
            h("div", { class: "d-title" }, `${node.parent}: ${node.outcome}`),
            h("p", { class: "d-note" }, `A child that goes to \`${node.outcome}\` ends ${node.parent} with this outcome; ${node.parent}'s own transitions (or an ancestor's) read it as \`${node.outcome}\`.`),
        )
    }
    const def = node.def
    const active = step?.active.includes(id)
    const call = step?.calls.find((c) => c.node === id && c.kind === "start")
    const outcome = step?.outcomes.find(([n]) => n === id)?.[1]
    const timers = (step?.timers ?? []).filter((t) => t.node === id && t.kind === "after")
    const activity = def.activity ? model.activities.get(def.activity) : null
    const kind = node.kind === "parallel" ? "parallel node" : node.kind === "compound" ? "node with children" : "node"
    return h(
        "div",
        { class: "details" },
        h("div", { class: "d-title" }, def.name, h("span", { class: `d-state ${active ? "on" : ""}` }, active ? "active" : "inactive")),
        h("div", { class: "d-sub" }, kind, node.parent ? ` inside ${node.parent}` : " (root)"),
        // what the node is doing right now, always one line, so the panel keeps its height as it changes
        h(
            "div",
            { class: "d-row d-now" },
            h("span", { class: "d-label" }, "now"),
            h(
                "span",
                { class: "d-value" },
                ...[
                    active && call ? h("span", { class: `d-chip ${call.phase}`, title: call.rpc }, call.phase === "held" ? "held: waiting on a resource" : `calling ${call.rpc}`) : null,
                    outcome ? h("span", { class: `d-chip ${outcome}` }, outcome) : null,
                    ...(step ? timers.map((t) => h("span", { class: "d-chip" }, `${t.transition == null ? "a transition" : `transition ${t.transition + 1}`} in ${Math.max(0, t.due - step.time).toFixed(1)}s`)) : []),
                ].filter(Boolean),
                !(active && call) && !outcome && !(step && timers.length) ? h("span", { class: "d-idle" }, active ? "active" : "idle") : null,
            ),
        ),
        activity
            ? h(
                "div",
                { class: "d-section" },
                h("div", { class: "d-head" }, "activity"),
                row("name", mono(activity.name)),
                row("start", mono(activity.start)),
                activity.cancel ? row("cancel", mono(activity.cancel)) : null,
                activity.uses.length ? row("uses", ...activity.uses.map((r) => h("span", { class: "d-chip" }, r))) : null,
                ...Object.entries(def.args).map(([key, source]) => row(`arg ${key}`, cel(source))),
                def.result ? row("result →", renderCel(def.result, names)) : null,
            )
            : null,
        def.children.length ? row("children", ...def.children.map((c) => h("span", { class: "d-chip" }, c === def.initial ? `▸ ${c}` : c))) : null,
        def.parallel.length ? row("parallel", ...def.parallel.map((c) => h("span", { class: "d-chip" }, c))) : null,
        def.outcomes.length ? row("outcomes", ...def.outcomes.map((c) => h("span", { class: "d-chip" }, c))) : null,
        def.claims.length ? row("claims", ...def.claims.map((c) => h("span", { class: "d-chip" }, c))) : null,
        ...checks("requires", def.requires, cel, "checked on entry; if one fails the node is not entered and its fallback is"),
        ...checks("ensures", def.ensures, cel, "checked on a graceful exit; if one fails the fallback is entered instead of the transition's target"),
        def.transitions.length
            ? h("div", { class: "d-section" }, h("div", { class: "d-head" }, "transitions"), ...def.transitions.map((t) => transitionLine(t, cel)))
            : null,
    )
}

function checks(kind, list, cel, note) {
    if (!list.length) {
        return []
    }
    return [
        h(
            "div",
            { class: "d-section" },
            h("div", { class: "d-head" }, kind),
            h("p", { class: "d-note" }, note),
            ...list.map((check) => h("div", { class: "d-check" }, ...check.expect.map((source) => h("div", {}, "✓ ", cel(source))), check.fallback ? h("div", { class: "d-fallback" }, "else → ", mono(check.fallback)) : h("div", { class: "d-fallback" }, "else → fault"))),
        ),
    ]
}

function transitionLine(transition, cel) {
    return h(
        "div",
        { class: "d-transition" },
        transition.on != null ? h("span", { class: "d-kw" }, "on ", mono(transition.on), " ") : null,
        transition.after != null ? h("span", { class: "d-kw" }, "after ", cel(transition.after), "s ") : null,
        transition.if != null ? h("span", { class: "d-kw" }, "if ", cel(transition.if), " ") : null,
        transition.on == null && transition.after == null && transition.if == null ? h("span", { class: "d-kw" }, "always ") : null,
        "→ ",
        mono(transition.goto),
        transition.mode === "immediate" ? h("span", { class: "d-chip immediate" }, "⚡ immediate") : null,
        ...Object.entries(transition.set).map(([key, source]) => h("div", { class: "d-set" }, "set ", h("span", { class: "pill pill-vars", "data-key": key }, key), " = ", cel(source))),
    )
}

export function edgeDetails(model, id, step) {
    const edge = model.edgeById.get(id)
    const names = namesFor(model, step?.blackboard)
    const cel = (source) => renderCel(source, names)
    const target = model.nodes.get(edge.to)
    const toName = target?.kind === "final" ? `${target.outcome} (ends ${target.parent})` : edge.to
    if (edge.kind === "initial") {
        return h("div", { class: "details" }, h("div", { class: "d-title" }, `${edge.node} enters ${edge.to} first`))
    }
    if (edge.kind === "requires" || edge.kind === "ensures") {
        return h(
            "div",
            { class: "details" },
            h("div", { class: "d-title" }, `${edge.from} ⇢ ${edge.to}`),
            h("div", { class: "d-sub" }, `fallback of a failed \`${edge.kind}\` check`),
            h("p", { class: "d-note" }, edge.kind === "requires" ? `On entering ${edge.from}, if any of these is false, ${edge.to} is entered instead.` : `On leaving ${edge.from} gracefully, if any of these is false, ${edge.to} is entered instead of the transition's target.`),
            ...edge.check.expect.map((source) => h("div", { class: "d-check" }, "✓ ", cel(source))),
        )
    }
    const transition = edge.transition
    const trigger = transition.on != null && RESERVED.includes(transition.on)
        ? h("span", {}, `when ${edge.from} reaches `, h("span", { class: "pill pill-outcome" }, transition.on))
        : transition.on != null
        ? h("span", {}, "on each message on ", h("code", { class: "d-mono d-stream" }, transition.on))
        : transition.after != null
        ? h("span", {}, cel(transition.after), " seconds after entering")
        : h("span", {}, "as soon as its condition holds")
    return h(
        "div",
        { class: "details" },
        h("div", { class: "d-title" }, `${edge.from} → ${toName}`),
        h("div", { class: "d-sub" }, `transition ${edge.index + 1} of ${edge.from}`),
        row("trigger", trigger),
        transition.if != null ? row("if", cel(transition.if)) : null,
        row(
            "mode",
            transition.mode === "immediate"
                ? h("span", { class: "d-chip immediate" }, "⚡ immediate: leaves at once, skipping `ensures`")
                : h("span", { class: "d-chip" }, "graceful: `ensures` checked on the way out"),
        ),
        ...Object.entries(transition.set).map(([key, source]) => row("set", h("span", { class: "pill pill-vars", "data-key": key }, key), " = ", cel(source))),
    )
}

/** A blackboard key's value, group and where it comes from. */
export function valueDetails(model, key, step, modules) {
    const names = namesFor(model, step?.blackboard)
    const kind = names.kindOf(key)
    const has = step && key in step.blackboard
    const streamValue = model.streamValues.get(key)
    const publisher = streamValue ? publisherOf(modules, streamValue.stream) : null
    return h(
        "div",
        { class: "details value-details" },
        h("div", { class: "d-title" }, key, h("span", { class: `d-chip pill-${kind}` }, kind)),
        kind === "outcome" ? h("p", { class: "d-note" }, "true for the node whose transition reads it, when it reached that outcome") : null,
        streamValue ? row("stream", mono(`${streamValue.stream}.${streamValue.field}`)) : null,
        publisher ? row("set by", mono(publisher)) : null,
        model.results.has(key) ? row("set by", ...model.results.get(key).map((n) => mono(`${n} (its activity's return)`))) : null,
        model.setters.has(key) ? row("set by", h("span", {}, `${model.setters.get(key).length} transition(s)`)) : null,
        kind === "outcome" ? null : h("pre", { class: "d-json" }, has ? renderJson(step.blackboard[key]) : h("span", { class: "j-null" }, "unset")),
    )
}

/** The module whose output stream a stream value reads, from the gateway's module list. */
export function publisherOf(modules, stream) {
    const [module, name] = stream.split(".")
    for (const live of modules ?? []) {
        for (const found of live.streams ?? []) {
            if (found.name === name && (live.class === module || live.id.endsWith(module.toLowerCase())) && found.direction !== "in") {
                return `${live.id} → ${found.name} (${found.type})`
            }
        }
    }
    return null
}
