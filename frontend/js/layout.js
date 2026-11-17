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
export function layoutGraph(model, measure, labelWidth = () => 0, aspect = 1.6) {
    // Inner nodes aim for one shape (square, wide or tall); keep whichever lets the whole graph fill the screen most.
    const tries = [1, 2.5, 0.5].map((innerAspect) => layoutWith(model, measure, labelWidth, aspect, innerAspect))
    const fill = (found) => Math.min(aspect / found.width, 1 / found.height)
    return tries.reduce((best, found) => (fill(found) > fill(best) * 1.02 ? found : best))
}

function layoutWith(model, measure, labelWidth, aspect, innerAspect) {
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
        const boxes = node.inside.map((child) => ({ id: child, ...size(child) }))
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
                const { points, mid } = sampleSegments(edgeSegments(model, edge, from, to, placement.routes.get(linkEdges.indexOf(edge.id)) ?? [], labelWidth))
                points.forEach((point) => grow({ ...point, w: 0, h: 0 }))
                grow(labelBox(mid, labelWidth(edge)))
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
        const shift = (point) => ({ x: point.x - minX + PAD, y: point.y - minY + PAD + HEADER })
        const place = new Map(boxes.map((box) => [box.id, shift(placement.positions.get(box.id))]))
        const routes = new Map()
        linkEdges.forEach((edgeId, index) => routes.set(edgeId, (placement.routes.get(index) ?? []).map(shift)))
        const measured = measure(node)
        const result = {
            w: Math.max(maxX - minX + PAD * 2, measured.w),
            h: maxY - minY + PAD * 2 + HEADER,
        }
        local.set(id, { ...result, place, routes })
        return result
    }
    const rootSize = size(model.root)
    const rects = new Map()
    const routes = new Map()
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
        }
    }
    place(model.root, 0, 0, rootSize.w, rootSize.h)
    return { rects, routes, width: rootSize.w, height: rootSize.h }
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
        const length = Math.hypot(toCentre.x - fromCentre.x, toCentre.y - fromCentre.y) || 1
        const k = twins.indexOf(edge) - (twins.length - 1) / 2
        const sign = edge.from < edge.to ? 1 : -1
        // Spread twins so their labels sit side by side: by label width across a vertical edge, by label height along a horizontal one.
        const across = Math.abs(toCentre.y - fromCentre.y) > Math.abs(toCentre.x - fromCentre.x)
        const step = across ? Math.max(...twins.map((twin) => labelWidth(twin))) + 8 : 26
        const offset = k * step * sign
        // bow out from the middle of the gap between the two boxes (the centres' midpoint can sit inside a big compound)
        const a = boundaryPoint(from, toCentre)
        const b = boundaryPoint(to, fromCentre)
        bends = [{ x: (a.x + b.x) / 2 - ((toCentre.y - fromCentre.y) / length) * offset, y: (a.y + b.y) / 2 + ((toCentre.x - fromCentre.x) / length) * offset }]
    }
    const start = boundaryPoint(from, bends[0] ?? toCentre, 1)
    const end = boundaryPoint(to, bends.at(-1) ?? fromCentre, 3)
    return smoothSegments([start, ...bends, end])
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

/** Points along the curve, and the one halfway along it (where the label sits). */
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
    const half = lengths.at(-1) / 2
    const mid = points[Math.max(0, lengths.findIndex((length) => length >= half))] ?? points[0]
    return { points, mid }
}

/** An edge label's box around the point it is centred on (the label's text plus its padding, 18 high). */
export const labelBox = (mid, width) => ({ x: mid.x - width / 2, y: mid.y - 9, w: width, h: 18 })
