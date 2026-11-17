// The orchestrator definition as a graph (nodes nested in nodes, transitions and fallbacks as edges), and the
// blackboard keys sorted by where they come from.

export const OUTCOMES = ["done", "failed"]
export const RESERVED = ["succeeded", ...OUTCOMES]

/**
 * @typedef {object} GraphNode
 * @property {string} id
 * @property {"compound" | "parallel" | "leaf" | "final" | "start"} kind
 * @property {string | null} parent
 * @property {string[]} inside the ids drawn inside it, pseudo nodes included
 * @property {any} [def] the node as the file wrote it
 * @property {string} [outcome] a final node's outcome
 */

/**
 * @typedef {object} GraphEdge
 * @property {string} id
 * @property {"transition" | "requires" | "ensures" | "initial"} kind
 * @property {string} from
 * @property {string} to
 * @property {string} node the node the edge belongs to (its transition or check)
 * @property {number} index the transition's or check's place on that node
 * @property {any} [transition]
 * @property {any} [check]
 */

/** Where a `goto` lands: a node, or the outcome marker inside the node's parent. */
function target(nodes, parentOf, from, goto) {
    if (nodes.has(goto)) {
        return goto
    }
    return `${parentOf.get(from)}::${goto}`
}

/** What the engine logs as a transition's cause (engine.py `_cause`). */
export function causeOf(transition) {
    if (transition.on != null) {
        return `on ${transition.on}`
    }
    if (transition.after != null) {
        return "after"
    }
    return transition.if != null ? `if ${transition.if}` : null
}

export function buildModel(definition) {
    const defs = new Map(definition.nodes.map((node) => [node.name, node]))
    const parentOf = new Map()
    for (const node of definition.nodes) {
        for (const name of [...node.children, ...node.parallel]) {
            parentOf.set(name, node.name)
        }
    }
    /** @type {Map<string, GraphNode>} */
    const nodes = new Map()
    for (const node of definition.nodes) {
        const kind = node.parallel.length ? "parallel" : node.children.length ? "compound" : "leaf"
        nodes.set(node.name, {
            id: node.name,
            kind,
            parent: parentOf.get(node.name) ?? null,
            inside: [...node.children, ...node.parallel],
            def: node,
        })
    }
    /** @type {GraphEdge[]} */
    const edges = []
    const addFinal = (parent, outcome) => {
        const id = `${parent}::${outcome}`
        if (!nodes.has(id)) {
            nodes.set(id, { id, kind: "final", parent, inside: [], outcome })
            nodes.get(parent).inside.push(id)
        }
        return id
    }
    for (const node of definition.nodes) {
        if (node.initial) {
            const id = `${node.name}::start`
            nodes.set(id, { id, kind: "start", parent: node.name, inside: [] })
            nodes.get(node.name).inside.unshift(id)
            edges.push({ id: `${node.name}::initial`, kind: "initial", from: id, to: node.initial, node: node.name, index: 0 })
        }
        node.transitions.forEach((transition, index) => {
            const parent = parentOf.get(node.name)
            if (!defs.has(transition.goto) && parent != null) {
                addFinal(parent, transition.goto)
            }
            edges.push({
                id: `${node.name}#${index}`,
                kind: "transition",
                from: node.name,
                to: target(defs, parentOf, node.name, transition.goto),
                node: node.name,
                index,
                transition,
            })
        })
        for (const kind of ["requires", "ensures"]) {
            node[kind].forEach((check, index) => {
                if (check.fallback) {
                    edges.push({
                        id: `${node.name}!${kind}${index}`,
                        kind,
                        from: node.name,
                        to: check.fallback,
                        node: node.name,
                        index,
                        check,
                    })
                }
            })
        }
    }
    const activities = new Map(definition.activities.map((activity) => [activity.name, activity]))
    const signals = new Map(definition.signals.map((signal) => [signal.name, signal]))
    const events = new Map(definition.events.map((event) => [event.name, event]))
    const results = new Map()
    for (const node of definition.nodes) {
        if (node.result) {
            results.set(node.result, [...(results.get(node.result) ?? []), node.name])
        }
    }
    /** For each key, the transitions whose `set` writes it. */
    const setters = new Map()
    for (const edge of edges) {
        for (const key of Object.keys(edge.transition?.set ?? {})) {
            setters.set(key, [...(setters.get(key) ?? []), edge.id])
        }
    }
    return {
        definition,
        root: definition.root,
        nodes,
        edges,
        edgeById: new Map(edges.map((edge) => [edge.id, edge])),
        activities,
        signals,
        events,
        results,
        setters,
        constants: definition.constants,
        vars: definition.vars,
    }
}

/** The edge a journal transition record took: by node, goto and cause, as the engine logs them. */
export function edgeForRecord(model, record) {
    const from = record.node
    if (record.cause === "requires" || record.cause === "ensures") {
        return model.edges.find((edge) => edge.kind === record.cause && edge.from === from && edge.to === record.goto)
    }
    const node = model.nodes.get(from)?.def
    if (!node) {
        return undefined
    }
    const index = node.transitions.findIndex(
        (transition) => transition.goto === record.goto && causeOf(transition) === record.cause,
    )
    return index < 0 ? undefined : model.edgeById.get(`${from}#${index}`)
}

/** Which group a blackboard key belongs in. */
export function groupOf(model, key) {
    if (model.signals.has(key)) {
        return "signals"
    }
    if (key in model.vars) {
        return "vars"
    }
    if (model.results.has(key)) {
        return "results"
    }
    if (key in model.constants) {
        return "constants"
    }
    return "other"
}

/** Every name an expression may read: keys, events and outcomes. */
export function knownNames(model, blackboard) {
    return new Set([
        ...Object.keys(blackboard ?? {}),
        ...Object.keys(model.constants),
        ...Object.keys(model.vars),
        ...model.signals.keys(),
        ...model.results.keys(),
        ...model.events.keys(),
        ...RESERVED,
    ])
}

export function ancestors(model, id) {
    const found = []
    let at = model.nodes.get(id)?.parent
    while (at != null) {
        found.push(at)
        at = model.nodes.get(at)?.parent
    }
    return found
}
