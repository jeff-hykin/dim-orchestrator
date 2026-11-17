// Nested layout: each compound node lays out the nodes inside it with the layered layout, sized from the inside out,
// and every edge is routed at the level of the compound that holds both its ends.

import { layered } from "./layered.js"

export const PAD = 14
export const HEADER = 30

/**
 * @param {ReturnType<import("./model.js").buildModel>} model
 * @param {(node: import("./model.js").GraphNode) => { w: number, h: number }} measure a non-compound node's size
 * @param {(edge: import("./model.js").GraphEdge) => number} labelWidth how wide an edge's label is
 * @returns {{ rects: Map<string, {x: number, y: number, w: number, h: number}>, routes: Map<string, {x: number, y: number}[]>, width: number, height: number }}
 */
export function layoutGraph(model, measure, labelWidth = () => 0, aspect = 1.6, arcs = false) {
    // Inner nodes aim for one shape (square, wide or tall); keep whichever lets the whole graph fill the screen most.
    const tries = [1, 2.5, 0.5].map((innerAspect) => layoutWith(model, measure, labelWidth, aspect, innerAspect, arcs))
    const fill = (found) => Math.min(aspect / found.width, 1 / found.height)
    return tries.reduce((best, found) => (fill(found) > fill(best) * 1.02 ? found : best))
}

function layoutWith(model, measure, labelWidth, aspect, innerAspect, arcs) {
    const local = new Map() // id -> { w, h, place: Map<childId, {x, y}> (centres, content-relative), routes }
    const childOf = (compound, id) => {
        let at = id
        while (at != null) {
            const parent = model.nodes.get(at)?.parent
            if (parent === compound) {
                return at
            }
            at = parent
        }
        return null
    }
    // Where `id` and everything inside it sit, with `id`'s corner at (x, y), from the inner layouts done so far.
    const nestedRects = (id, x, y, into) => {
        const inner = local.get(id)
        const own = inner ?? measure(model.nodes.get(id))
        into.set(id, { x, y, w: own.w, h: own.h })
        for (const [child, centre] of inner?.place ?? []) {
            const childSize = local.get(child) ?? measure(model.nodes.get(child))
            nestedRects(child, x + centre.x - childSize.w / 2, y + centre.y - childSize.h / 2, into)
        }
        return into
    }
    const size = (id) => {
        const node = model.nodes.get(id)
        if (node.kind !== "compound" && node.kind !== "parallel") {
            return measure(node)
        }
        // a container's start is drawn as an arrow from its top-left corner, which needs a little room there
        const corner = node.def?.initial ? 12 : 0
        const boxes = node.inside.filter((child) => model.nodes.get(child)?.kind !== "start").map((child) => ({ id: child, ...size(child) }))
        const links = []
        const linkEdges = []
        for (const edge of model.edges) {
            const a = childOf(id, edge.from)
            const b = childOf(id, edge.to)
            if (a && b && a !== b) {
                links.push({ from: a, to: b })
                linkEdges.push(edge.id)
            }
        }
        // Lay the inside out left-to-right and top-to-bottom, and keep the one closer to the screen's shape.
        const widest = Math.max(0, ...linkEdges.map((edgeId) => labelWidth(model.edgeById.get(edgeId))))
        const across = layered(boxes, links, { layerGap: Math.min(240, Math.max(70, widest + 36)), nodeGap: 30 })
        const flip = (point) => ({ x: point.y, y: point.x })
        const downRaw = layered(boxes.map((box) => ({ ...box, w: box.h, h: box.w })), links, { layerGap: 66, nodeGap: Math.max(36, Math.min(160, widest * 0.5)) })
        const down = {
            positions: new Map([...downRaw.positions].map(([key, point]) => [key, flip(point)])),
            routes: new Map([...downRaw.routes].map(([key, points]) => [key, points.map(flip)])),
        }
        // Everything drawn inside: the children, and every edge this node holds (its curve and its label).
        const bounds = (placement) => {
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
            const grow = (rect) => {
                x0 = Math.min(x0, rect.x)
                x1 = Math.max(x1, rect.x + rect.w)
                y0 = Math.min(y0, rect.y)
                y1 = Math.max(y1, rect.y + rect.h)
            }
            const rects = new Map()
            for (const box of boxes) {
                const at = placement.positions.get(box.id)
                nestedRects(box.id, at.x - box.w / 2, at.y - box.h / 2, rects)
                grow(rects.get(box.id))
            }
            const held = (edge) => (edge.from === edge.to ? model.nodes.get(edge.from)?.parent === id : linkEdges.includes(edge.id))
            for (const edge of model.edges.filter(held)) {
                const from = rects.get(edge.from)
                const to = rects.get(edge.to)
                if (!from || !to) {
                    continue
                }
                const bends = placement.routes.get(linkEdges.indexOf(edge.id)) ?? []
                const shape = edgeShape(model, edge, from, to, bends, labelWidth, arcs ? placement === down : null)
                const { points, mid, side } = sampleSegments(shape)
                points.forEach((point) => grow({ ...point, w: 0, h: 0 }))
                grow(labelBox(mid, labelWidth(edge), side))
            }
            return boxes.length ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: 0, y1: 0 }
        }
        // The root keeps whichever fills the screen larger; a node inside keeps whichever is closer to `innerAspect`.
        const misfit = (placement) => {
            const b = bounds(placement)
            const w = Math.max(1, b.x1 - b.x0) + PAD * 2
            const h = Math.max(1, b.y1 - b.y0) + PAD * 2 + HEADER
            return id === model.root ? -Math.min(aspect / w, 1 / h) : Math.abs(Math.log(w / h / innerAspect))
        }
        const placement = misfit(down) < misfit(across) ? down : across
        let { x0: minX, y0: minY, x1: maxX, y1: maxY } = bounds(placement)
        const shift = (point) => ({ x: point.x - minX + PAD + corner, y: point.y - minY + PAD + HEADER + corner })
        const place = new Map(boxes.map((box) => [box.id, shift(placement.positions.get(box.id))]))
        const routes = new Map()
        linkEdges.forEach((edgeId, index) => routes.set(edgeId, (placement.routes.get(index) ?? []).map(shift)))
        const measured = measure(node)
        const result = {
            w: Math.max(maxX - minX + PAD * 2 + corner, measured.w),
            h: maxY - minY + PAD * 2 + HEADER + corner,
        }
        local.set(id, { ...result, place, routes, vertical: placement === down })
        return result
    }
    const rootSize = size(model.root)
    const rects = new Map()
    const routes = new Map()
    const vertical = new Map() // edge id -> whether the container holding it flows top to bottom
    const place = (id, x, y, w, h) => {
        rects.set(id, { x, y, w, h })
        const inner = local.get(id)
        if (!inner) {
            return
        }
        for (const [child, centre] of inner.place) {
            const childSize = local.get(child) ?? measure(model.nodes.get(child))
            place(child, x + centre.x - childSize.w / 2, y + centre.y - childSize.h / 2, childSize.w, childSize.h)
        }
        for (const [edgeId, points] of inner.routes) {
            routes.set(edgeId, points.map((point) => ({ x: x + point.x, y: y + point.y })))
            vertical.set(edgeId, inner.vertical)
        }
    }
    place(model.root, 0, 0, rootSize.w, rootSize.h)
    return { rects, routes, vertical, width: rootSize.w, height: rootSize.h }
}

/** Where the ray from a rect's centre towards `toward` leaves the rect. */
export function boundaryPoint(rect, toward, inset = 0) {
    const cx = rect.x + rect.w / 2
    const cy = rect.y + rect.h / 2
    const dx = toward.x - cx
    const dy = toward.y - cy
    if (!dx && !dy) {
        return { x: cx, y: cy }
    }
    const hw = rect.w / 2 + inset
    const hh = rect.h / 2 + inset
    const scale = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity)
    return { x: cx + dx * scale, y: cy + dy * scale }
}

/**
 * An edge's curve as cubic Bézier segments `[p0, c1, c2, p3]`: a loop off the top-right corner for a self-transition,
 * else a smooth curve through the layout's bends (twins without bends bowed apart so their labels sit side by side).
 */
export function edgeSegments(model, edge, from, to, bends, labelWidth) {
    if (edge.from === edge.to) {
        const x = from.x + from.w - 18
        const y = from.y
        return [[{ x, y }, { x: x + 10, y: y - 34 }, { x: x + 44, y: y - 10 }, { x: from.x + from.w, y: y + 14 }]]
    }
    const fromCentre = { x: from.x + from.w / 2, y: from.y + from.h / 2 }
    const toCentre = { x: to.x + to.w / 2, y: to.y + to.h / 2 }
    const twins = model.edges.filter((other) => (other.from === edge.from && other.to === edge.to) || (other.from === edge.to && other.to === edge.from))
    if (twins.length > 1 && bends.length === 0) {
        return twinSegments(from, to, twins.indexOf(edge), twins.length)
    }
    const start = boundaryPoint(from, bends[0] ?? toCentre, 1)
    const end = boundaryPoint(to, bends.at(-1) ?? fromCentre, 3)
    return smoothSegments([start, ...bends, end])
}

/**
 * One of several transitions between the same two nodes: each gets its own lane, a port beside the others on the
 * facing sides, and runs straight across; their labels are staggered along the way so they never sit on each other.
 */
function twinSegments(from, to, index, count) {
    const gapY = Math.max(to.y - (from.y + from.h), from.y - (to.y + to.h))
    const gapX = Math.max(to.x - (from.x + from.w), from.x - (to.x + to.w))
    const vertical = gapY >= gapX
    const room = (vertical ? Math.min(from.w, to.w) : Math.min(from.h, to.h)) - 16
    const step = Math.min(22, room / Math.max(1, count - 1))
    const offset = (index - (count - 1) / 2) * step
    const centre = (rect) => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 })
    const [a, b] = [centre(from), centre(to)]
    let start
    let end
    if (vertical) {
        const down = b.y > a.y
        start = { x: a.x + offset, y: down ? from.y + from.h : from.y }
        end = { x: b.x + offset, y: down ? to.y - 3 : to.y + to.h + 3 }
    } else {
        const right = b.x > a.x
        start = { x: right ? from.x + from.w : from.x, y: a.y + offset }
        end = { x: right ? to.x - 3 : to.x + to.w + 3, y: b.y + offset }
    }
    const half = vertical ? (end.y - start.y) / 2 : (end.x - start.x) / 2
    const segments = [[start, vertical ? { x: start.x, y: start.y + half } : { x: start.x + half, y: start.y }, vertical ? { x: end.x, y: end.y - half } : { x: end.x - half, y: end.y }, end]]
    if (count === 2) {
        // two lanes: each label sits beside its own lane, on the outer side, so both read at the same height
        segments.labelShift = vertical ? { x: index ? 1 : -1, y: 0 } : { x: 0, y: index ? 1 : -1 }
    } else {
        segments.labelAt = (index + 1) / (count + 1)
    }
    return segments
}

/** A smooth curve through points (Catmull-Rom as cubic Béziers). */
function smoothSegments(points) {
    const segments = []
    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[i - 1] ?? points[i]
        const p1 = points[i]
        const p2 = points[i + 1]
        const p3 = points[i + 2] ?? p2
        segments.push([p1, { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 }, { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 }, p2])
    }
    return segments
}

/** The SVG path of `edgeSegments`. */
export function segmentsPath(segments) {
    const f = (point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`
    return segments.length ? `M${f(segments[0][0])}` + segments.map(([, c1, c2, p]) => ` C${f(c1)} ${f(c2)} ${f(p)}`).join("") : ""
}

/** Points along the curve, the one its label points at (halfway, unless the curve says `labelAt`), and which side of it
 * the label sits on. */
export function sampleSegments(segments, perSegment = 16) {
    const points = []
    for (const [a, b, c, d] of segments) {
        for (let i = points.length ? 1 : 0; i <= perSegment; i++) {
            const t = i / perSegment
            const u = 1 - t
            points.push({
                x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
                y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y,
            })
        }
    }
    const lengths = [0]
    for (let i = 1; i < points.length; i++) {
        lengths.push(lengths[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y))
    }
    const at = lengths.at(-1) * (segments.labelAt ?? 0.5)
    const index = Math.max(0, lengths.findIndex((length) => length >= at))
    const mid = points[index] ?? points[0]
    // the label sits beside the curve, not on it: to the right of a steep stretch, above a flat one
    const before = points[Math.max(0, index - 1)]
    const after = points[Math.min(points.length - 1, index + 1)]
    const steep = Math.abs(after.y - before.y) > Math.abs(after.x - before.x)
    const side = segments.labelShift ?? (steep ? { x: 1, y: 0 } : { x: 0, y: -1 })
    return { points, mid, side }
}

/** An edge label's box around the point it is centred on (the label's text plus its padding, 18 high), moved by `shift`
 * (in half-sizes) to one side of it. */
export const labelBox = (mid, width, shift = { x: 0, y: 0 }) => ({ x: mid.x - width / 2 + shift.x * (width / 2 + 9), y: mid.y - 9 + shift.y * 18, w: width, h: 18 })

/**
 * An edge's curve: dimos-react's arc when `vertical` is given (true or false: which way its container flows), else
 * our smooth curve. A back edge with no bends has no track for an arc to run along, so it keeps the smooth curve.
 */
export function edgeShape(model, edge, from, to, bends, labelWidth, vertical = null) {
    const backward = vertical ? to.y + to.h <= from.y : to.x + to.w <= from.x
    const twins = model.edges.filter((other) => (other.from === edge.from && other.to === edge.to) || (other.from === edge.to && other.to === edge.from))
    // twins with no bends would share one arc, so they keep the smooth curves, which spread them apart
    if (vertical == null || edge.from === edge.to || (bends.length === 0 && (backward || twins.length > 1))) {
        return edgeSegments(model, edge, from, to, bends, labelWidth)
    }
    return arcSegments(from, to, bends, vertical)
}

/**
 * dimos-react's flow edge (src/graph/paths.ts) as cubic segments: out of the right side of `from` (bottom, when the
 * container flows down) and into the left side (top) of `to`, along the track its layered bends give.
 */
function arcSegments(from, to, bends, vertical) {
    const uv = (p) => (vertical ? { u: p.y, v: p.x } : { u: p.x, v: p.y })
    const xy = (u, v) => (vertical ? { x: v, y: u } : { x: u, y: v })
    const a = uv(vertical ? { x: from.x + from.w / 2, y: from.y + from.h } : { x: from.x + from.w, y: from.y + from.h / 2 })
    const b = uv(vertical ? { x: to.x + to.w / 2, y: to.y } : { x: to.x, y: to.y + to.h / 2 })
    const curve = (p0, p1, p2, p3) => [xy(...p0), xy(...p1), xy(...p2), xy(...p3)]
    const line = (p, q) => curve(p, p, q, q)
    if (!bends.length) {
        const half = Math.max(Math.abs(b.u - a.u) / 2, 30)
        return [curve([a.u, a.v], [a.u + half, a.v], [b.u - half, b.v], [b.u, b.v])]
    }
    const track = bends.map((p) => uv(p).v).sort((m, n) => m - n)[Math.floor(bends.length / 2)]
    const forward = b.u > a.u
    const r = Math.max(32, Math.min(110, forward ? Math.abs(b.u - a.u) / 3 : 80))
    if (forward) {
        return [
            curve([a.u, a.v], [a.u + r / 2, a.v], [a.u + r / 2, track], [a.u + r, track]),
            line([a.u + r, track], [b.u - r, track]),
            curve([b.u - r, track], [b.u - r / 2, track], [b.u - r / 2, b.v], [b.u, b.v]),
        ]
    }
    return [
        curve([a.u, a.v], [a.u + r, a.v], [a.u + r, track], [a.u, track]),
        line([a.u, track], [b.u, track]),
        curve([b.u, track], [b.u - r, track], [b.u - r, b.v], [b.u, b.v]),
    ]
}
