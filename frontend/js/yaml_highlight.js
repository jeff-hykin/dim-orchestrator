// YAML highlighting that knows the orchestrator file: besides YAML's own pieces (keys, punctuation, strings, numbers)
// it colors what each value means from the key it sits under: CEL in `if`/`when`/`expect`/`args`/`set` (blackboard names
// in their kind's color, operators, functions), RPC names, node names, and the outcomes (succeeded/done, failed).

import { h } from "./details.js"

const CEL_KEYS = new Set(["when", "if", "expect", "after"])
const CEL_PARENTS = new Set(["set", "args"])
const RPC_KEYS = new Set(["start", "cancel", "stream"])
const NODE_KEYS = new Set(["goto", "initial", "root", "fallback"])
const NODE_LISTS = new Set(["children", "parallel"])
const NAME_KINDS = { node: "t-node", signal: "t-k-signals", event: "t-k-event", activity: "t-activity" }

/**
 * @param {string} source YAML text
 * @param {{ known: Set<string>, kindOf: (name: string) => string } | null} names what the blackboard knows, for CEL
 */
export function highlightOrchestratorYaml(source, names) {
    const out = []
    const stack = [] // { indent, key } of the keys the current line sits under
    for (const [index, line] of source.split("\n").entries()) {
        if (index) {
            out.push("\n")
        }
        const match = /^(\s*)((?:-\s+)*)(?:((?:[^\s#:'"[\]{},-][^#:\n]*?)|"[^"\n]*"|'[^'\n]*')(:)(?=\s|$))?(.*)$/.exec(line)
        const [, indent, dashes, key, colon, rest] = match
        out.push(indent)
        if (dashes) {
            out.push(span("t-punct", dashes))
        }
        const at = indent.length + dashes.length
        while (stack.length && stack.at(-1).indent >= at) {
            stack.pop()
        }
        const parent = stack.at(-1)?.key
        let context
        if (key) {
            out.push(span("t-key", key), span("t-punct", colon))
            context = { key, parent, list: stack.findLast((entry) => entry.indent < at)?.key }
            stack.push({ indent: at, key })
        } else {
            context = { key: null, parent, list: parent }
        }
        out.push(...value(rest, context, names))
    }
    return out
}

const span = (cls, text) => h("span", { class: cls }, text)

/** The rest of a line after its key: a comment, a flow list, or one scalar. */
function value(rest, context, names) {
    const comment = /(^|\s)#.*$/.exec(rest.replace(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/g, (quoted) => " ".repeat(quoted.length)))
    const body = comment ? rest.slice(0, comment.index + comment[1].length) : rest
    const out = []
    const lead = /^\s*/.exec(body)[0]
    out.push(lead)
    const text = body.slice(lead.length)
    if (/^[[{]/.test(text)) {
        // a flow list or map: punctuation, a map's keys, and each value as a scalar under its key
        const pieces = text.split(/("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|\s*[[\]{},]\s*|:\s+)/).filter(Boolean)
        let flowKey = null
        pieces.forEach((piece, i) => {
            if (/^\s*[[\]{},]\s*$/.test(piece) || /^:\s+$/.test(piece)) {
                out.push(span("t-punct", piece))
                if (/[,{]/.test(piece)) {
                    flowKey = null
                }
            } else if (/^:\s+$/.test(pieces[i + 1] ?? "")) {
                flowKey = piece.trim()
                out.push(span("t-key", piece))
            } else {
                out.push(...scalar(piece, flowKey ? { key: flowKey, parent: context.key, list: context.list } : context, names))
            }
        })
    } else if (text) {
        out.push(...scalar(text, context, names))
    }
    if (comment) {
        out.push(span("t-com", rest.slice(body.length)))
    }
    return out
}

/** One scalar, colored by what the key above it says it is. */
function scalar(text, { key, parent, list }, names) {
    const trimmed = text.trimEnd()
    const tail = text.slice(trimmed.length)
    const quoted = /^(["'])([\s\S]*)\1$/.exec(trimmed)
    const inner = quoted ? quoted[2] : trimmed
    const wrap = (parts) => (quoted ? [span("t-punct", quoted[1]), ...parts, span("t-punct", quoted[1]), tail] : [...parts, tail])
    const owner = key ?? list
    if (owner && (CEL_KEYS.has(owner) || CEL_PARENTS.has(parent))) {
        return wrap(cel(inner, names))
    }
    if (owner && RPC_KEYS.has(owner)) {
        return wrap([span("t-rpc", inner)])
    }
    if (owner && (NODE_KEYS.has(owner) || NODE_LISTS.has(owner))) {
        return wrap([span(outcomeClass(inner) ?? "t-node", inner)])
    }
    if (owner === "outcomes") {
        return wrap([span(outcomeClass(inner) ?? "t-ok", inner)])
    }
    if (owner === "activity") {
        return wrap([span("t-activity", inner)])
    }
    if (owner === "name" && NAME_KINDS[parent ?? list]) {
        return wrap([span(NAME_KINDS[parent ?? list], inner)])
    }
    if (quoted) {
        return [span("t-str", trimmed), tail]
    }
    if (/^-?\d[\d_]*(\.\d+)?([eE][+-]?\d+)?$/.test(inner)) {
        return [span("t-num", inner), tail]
    }
    if (/^(true|false|null|~)$/.test(inner)) {
        return [span("t-bool", inner), tail]
    }
    return [inner, tail]
}

const outcomeClass = (word) => (word === "failed" ? "t-bad" : word === "succeeded" || word === "done" ? "t-ok" : null)

/** A CEL expression: strings, numbers, operators, functions, and blackboard names in their kind's color. */
export function cel(source, names) {
    const out = []
    let at = 0
    for (const match of source.matchAll(/('(?:[^'\\]|\\.)*'?|"(?:[^"\\]|\\.)*"?)|(\b\d+(?:\.\d+)?\b)|(&&|\|\||==|!=|<=|>=|[<>!+\-*/%?:])|([A-Za-z_][\w.]*)(\s*\()?|([()[\]{},])/g)) {
        out.push(source.slice(at, match.index))
        const [all, string, number, operator, name, call, punct] = match
        if (string) {
            out.push(span("t-str", string))
        } else if (number) {
            out.push(span("t-num", number))
        } else if (operator) {
            out.push(span("t-op", operator))
        } else if (name && call) {
            out.push(span("t-func", name), span("t-punct", call))
        } else if (name) {
            out.push(celName(name, names))
        } else if (punct) {
            out.push(span("t-punct", punct))
        } else {
            out.push(all)
        }
        at = match.index + all.length
    }
    out.push(source.slice(at))
    return out
}

function celName(name, names) {
    if (name === "true" || name === "false" || name === "null") {
        return span("t-bool", name)
    }
    const outcome = outcomeClass(name)
    if (outcome) {
        return span(outcome, name)
    }
    const parts = name.split(".")
    const known = names && parts.map((_, i) => parts.slice(0, parts.length - i).join(".")).find((prefix) => names.known.has(prefix))
    return span(known ? `t-k-${names.kindOf(known)}` : "t-ident", name)
}
