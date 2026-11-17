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
        const bounds = (placement) => {
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
            for (const box of boxes) {
                const at = placement.positions.get(box.id)
                x0 = Math.min(x0, at.x - box.w / 2)
                x1 = Math.max(x1, at.x + box.w / 2)
                y0 = Math.min(y0, at.y - box.h / 2)
                y1 = Math.max(y1, at.y + box.h / 2)
            }
            return boxes.length ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: 0, y1: 0 }
        }
        const misfit = (placement) => {
            const b = bounds(placement)
            return Math.abs(Math.log(Math.max(1, b.x1 - b.x0) / Math.max(1, b.y1 - b.y0) / aspect))
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

/** A smooth SVG path through points (Catmull-Rom as cubic Béziers). */
export function smoothPath(points) {
    if (points.length < 2) {
        return ""
    }
    let path = `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`
    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[i - 1] ?? points[i]
        const p1 = points[i]
        const p2 = points[i + 1]
        const p3 = points[i + 2] ?? p2
        const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 }
        const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 }
        path += ` C${c1.x.toFixed(1)},${c1.y.toFixed(1)} ${c2.x.toFixed(1)},${c2.y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`
    }
    return path
}
