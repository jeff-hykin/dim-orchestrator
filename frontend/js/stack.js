// A node's outgoing conditions, stacked one row each in its box (in its header, for a node with children), each row
// across the whole box with a line above it. Each edge leaves its node from the right end of its own row.

export const ROW = 18
// how far an edge runs straight out of its row before it turns
export const LEAD = 14

/** The edges drawn as rows of `nodeId`'s stack, in the file's order: its transitions, then its fallbacks. */
export function stackOf(model, nodeId) {
    return (model.stacks ??= stacks(model)).get(nodeId) ?? []
}

function stacks(model) {
    const found = new Map()
    for (const edge of model.edges) {
        if (edge.kind === "transition" || edge.kind === "requires" || edge.kind === "ensures") {
            if (!found.has(edge.from)) {
                found.set(edge.from, [])
            }
            found.get(edge.from).push(edge)
        }
    }
    return found
}

/** Whether an edge leaves from a stack row. */
export const stacked = (edge) => edge.kind === "transition" || edge.kind === "requires" || edge.kind === "ensures"

/** Where a node's stack starts, from its top: under its title, subtitle and chips. */
export const stackTop = (size) => size.top ?? size.h

/** The point an edge leaves from: its row's right end, on its node's right side. */
export function portOf(model, edge, rect, top) {
    const index = stackOf(model, edge.from).indexOf(edge)
    return { x: rect.x + rect.w, y: rect.y + top + index * ROW + ROW / 2 }
}
