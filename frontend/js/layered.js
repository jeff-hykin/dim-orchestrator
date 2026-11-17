// The layered (Sugiyama-style) layout from dimos-react's src/graph/layout.ts, as plain JS: break cycles, assign
// layers, order each layer to cut crossings, then place without overlap. Layers run left to right.

export const LAYER_GAP = 70
export const NODE_GAP = 26

/**
 * @typedef {{ id: string, w: number, h: number }} Box
 * @typedef {{ from: string, to: string }} Link
 * @typedef {{ x: number, y: number }} Point
 * @typedef {{ positions: Map<string, Point>, routes: Map<number, Point[]> }} Placement
 */

/**
 * @param {Box[]} nodes
 * @param {Link[]} edges
 * @returns {Placement} each node's centre, and each edge's bends (by its index in `edges`)
 */
export function layered(nodes, edges, { layerGap = LAYER_GAP, nodeGap = NODE_GAP } = {}) {
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const live = edges
        .map((edge, index) => ({ ...edge, index, reversed: false }))
        .filter((edge) => byId.has(edge.from) && byId.has(edge.to) && edge.from !== edge.to)
    const state = new Map()
    const outs = new Map(nodes.map((node) => [node.id, []]))
    for (const edge of live) {
        outs.get(edge.from).push(edge)
    }
    const visit = (id) => {
        state.set(id, 1)
        for (const edge of outs.get(id)) {
            const seen = state.get(edge.to)
            if (seen === 1) {
                edge.reversed = true
            } else if (!seen) {
                visit(edge.to)
            }
        }
        state.set(id, 2)
    }
    for (const node of nodes) {
        if (!state.get(node.id)) {
            visit(node.id)
        }
    }
    const dag = live.map((edge) => (edge.reversed ? { ...edge, from: edge.to, to: edge.from } : edge))
    const layer = new Map(nodes.map((node) => [node.id, 0]))
    const preds = new Map(nodes.map((node) => [node.id, []]))
    const succs = new Map(nodes.map((node) => [node.id, []]))
    for (const edge of dag) {
        preds.get(edge.to).push(edge.from)
        succs.get(edge.from).push(edge.to)
    }
    const indegree = new Map(nodes.map((node) => [node.id, preds.get(node.id).length]))
    const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id)
    while (queue.length) {
        const id = queue.shift()
        for (const next of succs.get(id)) {
            layer.set(next, Math.max(layer.get(next), layer.get(id) + 1))
            indegree.set(next, indegree.get(next) - 1)
            if (indegree.get(next) === 0) {
                queue.push(next)
            }
        }
    }
    for (const node of nodes) {
        const after = succs.get(node.id)
        if (preds.get(node.id).length === 0 && after.length) {
            layer.set(node.id, Math.max(0, Math.min(...after.map((id) => layer.get(id))) - 1))
        }
    }
    const dims = new Map(nodes.map((node) => [node.id, { w: node.w, h: node.h }]))
    const links = []
    const chains = new Map()
    for (const edge of dag) {
        let from = edge.from
        const chain = []
        for (let at = layer.get(edge.from) + 1; at < layer.get(edge.to); at++) {
            const dummy = `\u0000${edge.index}:${at}`
            layer.set(dummy, at)
            dims.set(dummy, { w: 0, h: 4 })
            links.push([from, dummy])
            chain.push(dummy)
            from = dummy
        }
        links.push([from, edge.to])
        chains.set(edge.index, { chain, reversed: edge.reversed })
    }
    const count = Math.max(0, ...layer.values()) + 1
    const layers = Array.from({ length: count }, () => [])
    for (const [id, at] of layer) {
        layers[at].push(id)
    }
    const up = new Map([...layer.keys()].map((id) => [id, []]))
    const down = new Map([...layer.keys()].map((id) => [id, []]))
    for (const [from, to] of links) {
        down.get(from).push(to)
        up.get(to).push(from)
    }
    const position = new Map()
    const index = () => layers.forEach((ids) => ids.forEach((id, i) => position.set(id, i)))
    index()
    const crossings = () => {
        let total = 0
        for (let at = 0; at + 1 < count; at++) {
            const pairs = []
            for (const id of layers[at]) {
                for (const to of down.get(id)) {
                    pairs.push([position.get(id), position.get(to)])
                }
            }
            for (let i = 0; i < pairs.length; i++) {
                for (let j = i + 1; j < pairs.length; j++) {
                    if ((pairs[i][0] - pairs[j][0]) * (pairs[i][1] - pairs[j][1]) < 0) {
                        total++
                    }
                }
            }
        }
        return total
    }
    let best = layers.map((ids) => [...ids])
    let fewest = crossings()
    for (let sweep = 0; sweep < 16 && fewest > 0; sweep++) {
        const downward = sweep % 2 === 0
        const order = downward ? [...layers.keys()] : [...layers.keys()].reverse()
        for (const at of order) {
            const near = downward ? up : down
            const centre = (id) => {
                const others = near.get(id)
                return others.length
                    ? others.reduce((sum, other) => sum + position.get(other), 0) / others.length
                    : position.get(id)
            }
            const keyed = layers[at].map((id) => [id, centre(id)])
            keyed.sort((a, b) => a[1] - b[1])
            layers[at] = keyed.map(([id]) => id)
            layers[at].forEach((id, i) => position.set(id, i))
        }
        const now = crossings()
        if (now < fewest) {
            fewest = now
            best = layers.map((ids) => [...ids])
        }
    }
    best.forEach((ids, at) => (layers[at] = ids))
    index()
    const widths = layers.map((ids) => Math.max(0, ...ids.map((id) => dims.get(id).w)))
    const columnX = []
    let x = 0
    for (let at = 0; at < count; at++) {
        columnX.push(x + widths[at] / 2)
        x += widths[at] + layerGap
    }
    const y = new Map()
    for (const ids of layers) {
        let top = 0
        for (const id of ids) {
            const h = dims.get(id).h
            y.set(id, top + h / 2)
            top += h + nodeGap
        }
    }
    const bottomOf = (ids) => {
        const last = ids[ids.length - 1]
        return last === undefined ? 0 : y.get(last) + dims.get(last).h / 2
    }
    const tallest = Math.max(0, ...layers.map(bottomOf))
    for (const ids of layers) {
        const shift = ids.length ? (tallest - bottomOf(ids)) / 2 : 0
        ids.forEach((id) => y.set(id, y.get(id) + shift))
    }
    const heights = (ids) => ids.map((id) => dims.get(id).h)
    for (let pass = 0; pass < 24; pass++) {
        const downward = pass % 2 === 0
        const order = downward ? [...layers.keys()] : [...layers.keys()].reverse()
        for (const at of order) {
            const ids = layers[at]
            const wanted = ids.map((id) => {
                const others = [...up.get(id), ...down.get(id)]
                return others.length ? others.reduce((sum, other) => sum + y.get(other), 0) / others.length : y.get(id)
            })
            placeInOrder(ids, wanted, heights(ids), nodeGap).forEach((value, i) => y.set(ids[i], value))
        }
    }
    const chainOf = new Map()
    for (const { chain } of chains.values()) {
        if (chain.length > 1) {
            chain.forEach((id) => chainOf.set(id, chain))
        }
    }
    const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
    for (let pass = 0; pass < 8; pass++) {
        const track = new Map()
        for (const chain of new Set(chainOf.values())) {
            track.set(chain, median(chain.map((id) => y.get(id))))
        }
        for (const ids of layers) {
            const wanted = ids.map((id) => (chainOf.has(id) ? track.get(chainOf.get(id)) : y.get(id)))
            placeInOrder(ids, wanted, heights(ids), nodeGap).forEach((value, i) => y.set(ids[i], value))
        }
    }
    const positions = new Map()
    for (const node of nodes) {
        positions.set(node.id, { x: columnX[layer.get(node.id)], y: y.get(node.id) })
    }
    const routes = new Map()
    for (const [edgeIndex, { chain, reversed }] of chains) {
        const points = chain.map((id) => ({ x: columnX[layer.get(id)], y: y.get(id) }))
        routes.set(edgeIndex, reversed ? points.reverse() : points)
    }
    return { positions, routes }
}

/** The closest centres to `wanted` that keep `ids` in order, NODE_GAP apart (pool-adjacent-violators). */
export function placeInOrder(ids, wanted, heights, nodeGap = NODE_GAP) {
    const offsets = [0]
    for (let i = 1; i < ids.length; i++) {
        offsets.push(offsets[i - 1] + heights[i - 1] / 2 + nodeGap + heights[i] / 2)
    }
    const blocks = []
    wanted.forEach((value, i) => {
        blocks.push({ sum: value - offsets[i], n: 1 })
        while (blocks.length > 1) {
            const last = blocks[blocks.length - 1]
            const before = blocks[blocks.length - 2]
            if (before.sum / before.n <= last.sum / last.n) {
                break
            }
            before.sum += last.sum
            before.n += last.n
            blocks.pop()
        }
    })
    const out = []
    for (const block of blocks) {
        for (let k = 0; k < block.n; k++) {
            out.push(block.sum / block.n + offsets[out.length])
        }
    }
    return out
}
