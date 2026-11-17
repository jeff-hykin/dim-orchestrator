// The graph laid out by ELK (Eclipse Layout Kernel, vendored in ../vendor/elk/), its layered algorithm across every
// level at once: containers grow to hold their edges and labels, labels get their own space, and edges are routed as
// splines or as straight segments. It runs in a worker.

import { ELK } from "../vendor/elk/elk-api.js"
import { HEADER, PAD } from "./layout.js"

const elk = new ELK({ workerUrl: new URL("../vendor/elk/elk-worker.min.js", import.meta.url).href })

export const ELK_ROUTINGS = { "elk-splines": "SPLINES", "elk-polyline": "POLYLINE" }

/**
 * @param {"elk-splines" | "elk-polyline"} style
 * @returns {Promise<{ rects: Map<string, {x: number, y: number, w: number, h: number}>, paths: Map<string, { d: string, label: {x: number, y: number} | null }>, width: number, height: number }>}
 */
export async function layoutElk(model, measure, labelWidth, style, aspect = 1.6) {
    // Lay it out flowing right and flowing down, and keep whichever fills the screen's shape larger.
    const tries = await Promise.all(["RIGHT", "DOWN"].map((direction) => run(model, measure, labelWidth, style, direction)))
    const fill = (found) => Math.min(aspect / found.width, 1 / found.height)
    return tries.reduce((best, found) => (fill(found) > fill(best) ? found : best))
}

async function run(model, measure, labelWidth, style, direction) {
    const shown = (id) => model.nodes.get(id)?.kind !== "start"
    const parentOf = (id) => model.nodes.get(id)?.parent
    const ancestors = (id) => {
        const found = []
        for (let at = parentOf(id); at != null; at = parentOf(at)) {
            found.push(at)
        }
        return found
    }
    const elkNodes = new Map()
    const build = (id) => {
        const node = model.nodes.get(id)
        const inside = node.inside.filter(shown)
        const element = { id, layoutOptions: {}, edges: [] }
        const parent = model.nodes.get(node.parent)
        if (parent?.def?.initial === id) {
            element.layoutOptions["elk.layered.layering.layerConstraint"] = "FIRST"
        }
        if (inside.length) {
            const size = measure(node)
            element.children = inside.map(build)
            // room in the top-left corner for the arrow to the entry node
            const corner = node.def?.initial ? 12 : 0
            element.layoutOptions["elk.padding"] = `[top=${HEADER + PAD + corner},left=${PAD + corner},bottom=${PAD},right=${PAD}]`
            element.layoutOptions["elk.nodeSize.constraints"] = "MINIMUM_SIZE"
            element.layoutOptions["elk.nodeSize.minimum"] = `(${size.w}, ${HEADER + PAD})`
        } else {
            const size = measure(node)
            element.width = size.w
            element.height = size.h
        }
        elkNodes.set(id, element)
        return element
    }
    const root = build(model.root)
    // An edge belongs to the deepest container holding both of its ends.
    for (const edge of model.edges) {
        if (edge.kind === "initial" || !shown(edge.from) || !shown(edge.to)) {
            continue
        }
        const fromUp = [edge.from, ...ancestors(edge.from)]
        const toUp = new Set([edge.to, ...ancestors(edge.to)])
        const owner = fromUp.find((id) => toUp.has(id) && id !== edge.from && id !== edge.to) ?? parentOf(edge.from) ?? model.root
        const width = labelWidth(edge)
        const elkEdge = { id: edge.id, sources: [edge.from], targets: [edge.to], labels: width > 14 ? [{ id: `${edge.id}::label`, text: edge.id, width, height: 18 }] : [] }
        ;(elkNodes.get(owner) ?? root).edges.push(elkEdge)
    }
    root.layoutOptions = {
        ...root.layoutOptions,
        "elk.algorithm": "layered",
        "elk.direction": direction,
        "elk.hierarchyHandling": "INCLUDE_CHILDREN",
        "elk.edgeRouting": ELK_ROUTINGS[style],
        "elk.edgeLabels.placement": "CENTER",
        "elk.layered.edgeLabels.centerLabelPlacementStrategy": "TAIL_LAYER",
        "elk.spacing.nodeNode": "28",
        "elk.layered.spacing.nodeNodeBetweenLayers": "36",
        "elk.spacing.edgeNode": "14",
        "elk.spacing.edgeEdge": "10",
        "elk.layered.spacing.edgeNodeBetweenLayers": "14",
        "elk.layered.spacing.edgeEdgeBetweenLayers": "10",
        "elk.spacing.edgeLabel": "4",
        "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
        "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
        "org.eclipse.elk.json.shapeCoords": "ROOT",
        "org.eclipse.elk.json.edgeCoords": "ROOT",
    }
    const laid = await elk.layout(root)
    const rects = new Map()
    const paths = new Map()
    const walk = (element) => {
        rects.set(element.id, { x: element.x ?? 0, y: element.y ?? 0, w: element.width, h: element.height })
        for (const edge of element.edges ?? []) {
            const label = edge.labels?.[0]
            paths.set(edge.id, {
                d: (edge.sections ?? []).map((section) => sectionPath(section, style)).join(" "),
                label: label ? { x: label.x + label.width / 2, y: label.y + label.height / 2 } : null,
            })
        }
        for (const child of element.children ?? []) {
            walk(child)
        }
    }
    walk(laid)
    return { rects, paths, width: laid.width, height: laid.height }
}

const f = (point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`

/** One ELK edge section as SVG: a chain of cubic Béziers, or straight segments. */
function sectionPath(section, style) {
    const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]
    if (style === "elk-splines" && (points.length - 1) % 3 === 0) {
        let d = `M${f(points[0])}`
        for (let i = 1; i < points.length; i += 3) {
            d += ` C${f(points[i])} ${f(points[i + 1])} ${f(points[i + 2])}`
        }
        return d
    }
    return `M${points.map(f).join(" L")}`
}
