// The state machine drawn as SVG: nested nodes, transitions and fallbacks as edges, the active nodes lit, and every
// transition the engine takes played along its edge.

import { namesFor } from "./details.js"
import { boundaryPoint, edgeShape, HEADER, labelBox, layoutGraph, PAD, sampleSegments, segmentsPath } from "./layout.js"
import { layoutElk } from "./layout_elk.js"
import { route, simplify } from "./route.js"
import { LEAD, portOf, ROW, stacked, stackOf, stackTop } from "./stack.js"

// how the graph is laid out and its edges drawn: our own nested layout with curves, or ELK with one of its routings
export const LAYOUT_STYLES = { curves: "Curves", arcs: "Arcs", "elk-polyline": "Corners", "elk-splines": "Splines" }

const SVG = "http://www.w3.org/2000/svg"
const svg = (tag, attrs = {}, parent) => {
    const element = document.createElementNS(SVG, tag)
    for (const [key, value] of Object.entries(attrs)) {
        element.setAttribute(key, String(value))
    }
    parent?.append(element)
    return element
}

// a dot is a rect whose corners follow the theme's --radius-round (square on a sharp skin)
const dot = (cx, cy, r, className, parent) => svg("rect", { x: cx - r, y: cy - r, width: 2 * r, height: 2 * r, rx: r, class: `dot ${className}` }, parent)

// container colors: blends of the skin's own colors, kept apart from the kind colors (vars, stream values, ...), --primary
// (the active state) and --danger (faults)
/**
 * A polyline as cubic segments, its corners rounded (radius up to `radius`, less where the legs are short, and less
 * where a wider swing would come within PADDING of one of `blockers`).
 */
function roundedSegments(points, radius = 10, blockers = []) {
    const clean = points.filter((point, i) => i === 0 || Math.hypot(point.x - points[i - 1].x, point.y - points[i - 1].y) > 0.5)
    const line = (a, b) => [a, a, b, b]
    if (clean.length < 3) {
        return clean.length === 2 ? [line(clean[0], clean[1])] : []
    }
    const segments = []
    let at = clean[0]
    for (let i = 1; i < clean.length - 1; i++) {
        const [p, c, n] = [clean[i - 1], clean[i], clean[i + 1]]
        const r = Math.min(radius, Math.hypot(c.x - p.x, c.y - p.y) / 2, Math.hypot(n.x - c.x, n.y - c.y) / 2)
        const toward = (from, to, d) => {
            const length = Math.hypot(to.x - from.x, to.y - from.y) || 1
            return { x: from.x + ((to.x - from.x) / length) * d, y: from.y + ((to.y - from.y) / length) * d }
        }
        let [enter, leave] = [toward(c, p, r), toward(c, n, r)]
        for (let tighter = r; tighter > 4 && cuts([enter, c, c, leave], blockers, PADDING); ) {
            tighter /= 1.5
            ;[enter, leave] = [toward(c, p, tighter), toward(c, n, tighter)]
        }
        segments.push(line(at, enter), [enter, c, c, leave])
        at = leave
    }
    segments.push(line(at, clean.at(-1)))
    return segments
}

// transition edges each take the next of these, so edges running side by side can be told apart (theme colors only)
const EDGE_COLORS = [
    "color-mix(in oklch, var(--info) 85%, var(--fg))",
    "color-mix(in oklch, var(--ok) 85%, var(--fg))",
    "color-mix(in oklch, var(--accent-alt) 80%, var(--fg))",
    "color-mix(in oklch, var(--warn) 55%, var(--ok))",
    "color-mix(in oklch, var(--danger) 45%, var(--accent-alt))",
    "color-mix(in oklch, var(--info) 50%, var(--ok))",
    "color-mix(in oklch, var(--warn) 75%, var(--fg))",
    "color-mix(in oklch, var(--info) 50%, var(--accent-alt))",
]

// how wide a routed edge swings round its corners when it falls back to rounded corners
const CURVE_RADIUS = 44
// how many times every edge is routed (each time with all the others in place)
const PASSES = 4
// how close a rounded corner may swing to a box it goes round
const PADDING = 6

/**
 * A route of straight horizontal and vertical stretches as flowing curves: each vertical stretch becomes one S (or C)
 * from the middle of the horizontal before it to the middle of the one after, level at both ends, so the edge leaves
 * and arrives flat and swings between them along its lane. A last stretch that comes in from above or below eases into
 * it. Where an S would cut across a box in `blockers`, that stretch keeps its rounded corners instead.
 */
/** Whether a cubic segment passes through any of `boxes` or within `margin` of one. */
function cuts([p0, p1, p2, p3], boxes, margin = 2) {
    for (let step = 1; step < 24; step++) {
        const t = step / 24
        const u = 1 - t
        const x = u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x
        const y = u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y
        if (boxes.some((box) => x > box.x - margin && x < box.x + box.w + margin && y > box.y - margin && y < box.y + box.h + margin)) {
            return true
        }
    }
    return false
}

function flowSegments(points, blockers = []) {
    const clean = simplify(points)
    if (clean.length < 3) {
        return roundedSegments(clean)
    }
    const segments = []
    let at = clean[0]
    for (let i = 1; i < clean.length; i++) {
        const [a, b] = [clean[i - 1], clean[i]]
        if (Math.abs(a.x - b.x) > 0.5) {
            continue
        }
        // a vertical stretch at x = a.x: from `at` to the middle of the next horizontal stretch (or the very end)
        const next = clean[i + 1]
        const to = next ? { x: (b.x + next.x) / 2, y: b.y } : b
        const curve = next ? [at, { x: a.x, y: at.y }, { x: a.x, y: to.y }, to] : [at, { x: a.x, y: at.y }, { x: a.x, y: (at.y + b.y) / 2 }, b]
        segments.push(...(cuts(curve, blockers) ? roundedSegments([at, { x: a.x, y: at.y }, { x: a.x, y: to.y }, to], CURVE_RADIUS, blockers) : [curve]))
        at = to
    }
    if (Math.hypot(at.x - clean.at(-1).x, at.y - clean.at(-1).y) > 0.5) {
        segments.push([at, at, clean.at(-1), clean.at(-1)])
    }
    return segments
}

const HUES = [
    "color-mix(in oklch, var(--info) 55%, var(--ok))",
    "color-mix(in oklch, var(--accent-alt) 55%, var(--danger))",
    "color-mix(in oklch, var(--warn) 50%, var(--danger))",
    "color-mix(in oklch, var(--info) 50%, var(--accent-alt))",
    "color-mix(in oklch, var(--ok) 50%, var(--warn))",
]

/** The point on `path` nearest to `point`, from a coarse walk along it. */
function nearestPoint(path, point) {
    const length = path.getTotalLength()
    let best = null
    for (let i = 0; i <= 60; i++) {
        const at = path.getPointAtLength((length * i) / 60)
        const distance = Math.hypot(at.x - point.x, at.y - point.y)
        if (!best || distance < best.distance) {
            best = { x: at.x, y: at.y, distance }
        }
    }
    return best
}

/**
 * A small point on the side of a label's box that faces its edge (like "<" before the text), as an open path: filled,
 * its closing side tucked 1px inside the box so it covers the box's border there, and only its two outer sides stroked.
 * Nothing when the edge runs through the box.
 */
function labelTip(box, anchor) {
    if (anchor.x > box.x && anchor.x < box.x + box.w && anchor.y > box.y && anchor.y < box.y + box.h) {
        return null
    }
    const reach = 6
    const half = 4.5
    const clamp = (value, low, high) => Math.min(high, Math.max(low, value))
    const f = (x, y) => `${x.toFixed(1)},${y.toFixed(1)}`
    if (anchor.x <= box.x || anchor.x >= box.x + box.w) {
        const left = anchor.x <= box.x
        const edgeX = left ? box.x + 1 : box.x + box.w - 1
        const y = clamp(anchor.y, box.y + half + 2, box.y + box.h - half - 2)
        return `M${f(edgeX, y - half)} L${f(left ? box.x - reach : box.x + box.w + reach, y)} L${f(edgeX, y + half)}`
    }
    const above = anchor.y <= box.y
    const edgeY = above ? box.y + 1 : box.y + box.h - 1
    const x = clamp(anchor.x, box.x + half + 4, box.x + box.w - half - 4)
    return `M${f(x - half, edgeY)} L${f(x, above ? box.y - reach : box.y + box.h + reach)} L${f(x + half, edgeY)}`
}

// how long one transition's animation takes, and how many may wait their turn before the rest are played at once
const FIRE_MS = 900
const FIRE_BACKLOG = 8

const short = (text, length = 34) => (text.length > length ? `${text.slice(0, length - 1)}…` : text)

/** The words an edge's label carries. */
export function edgeLabel(edge, length = 34) {
    if (edge.kind === "initial") {
        return ""
    }
    if (edge.kind === "requires" || edge.kind === "ensures") {
        return `${edge.kind} ✗`
    }
    const transition = edge.transition
    const parts = []
    if (transition.on != null) {
        parts.push(`on ${transition.on}`)
    }
    if (transition.after != null) {
        parts.push(`after ${transition.after}${/^[\d.]+$/.test(transition.after) ? "s" : ""}`)
    }
    if (transition.if != null) {
        parts.push(`if ${transition.if}`)
    }
    if (!parts.length) {
        parts.push("else")
    }
    return short(parts.join(" "), length)
}

export class GraphView {
    /**
     * @param {HTMLElement} container
     * @param {{ onHover: (target: any, event: PointerEvent) => void, onLeave: () => void, onTap: (target: any, event: PointerEvent) => void }} handlers
     */
    constructor(container, handlers) {
        this.container = container
        this.handlers = handlers
        this.root = svg("svg", { class: "graph" }, container)
        this.world = svg("g", { class: "world" }, this.root)
        this.view = { x: 0, y: 0, k: 1 }
        this.userMoved = false
        this.nodeEls = new Map()
        this.edgeEls = new Map()
        this.timerEls = new Map()
        this.style = "curves"
        this.frames = []
        this.setUpPanZoom()
        new ResizeObserver(() => !this.userMoved && this.fit()).observe(container)
    }

    measure(node) {
        const context = (this.canvas ??= document.createElement("canvas")).getContext("2d")
        const style = getComputedStyle(this.container)
        const sans = style.getPropertyValue("--sans") || "sans-serif"
        const mono = style.getPropertyValue("--mono") || "monospace"
        const width = (text, font) => {
            context.font = font
            return context.measureText(text).width
        }
        if (node.kind === "start") {
            return { w: 14, h: 14 }
        }
        if (node.kind === "final") {
            return { w: 46, h: 40 }
        }
        // the stack of its outgoing conditions: one row each, right-aligned
        const stack = this.model ? stackOf(this.model, node.id) : []
        const rows = Math.max(0, ...stack.map((edge) => width(this.rowText(edge), `10.5px ${mono}`) + 34))
        // its name sits above its box, in a band of its own, larger the higher the node sits; the box holds the rest
        const font = this.titleFont(node)
        const TITLE = font + 8
        const titleW = width(node.id, `600 ${font}px ${sans}`)
        if (node.kind === "compound" || node.kind === "parallel") {
            const head = TITLE + (stack.length ? stack.length * ROW + 4 : 0)
            return { w: Math.max(titleW + (node.kind === "parallel" ? 90 : 20), rows), h: head, head, top: TITLE, titleW, title: TITLE, font }
        }
        const sub = this.subtitle(node)
        const chips = this.chips(node).join("  ")
        const w = Math.max(titleW + 22, sub ? width(sub, `11px ${mono}`) + 20 : 0, chips ? width(chips, `10px ${mono}`) + 20 : 0)
        const lines = (sub ? 1 : 0) + (chips ? 1 : 0)
        const inner = lines ? 6 + lines * 16 : 0
        const box = Math.max(14, inner + stack.length * ROW + (inner || stack.length ? 4 : 0))
        return { w: Math.max(Math.ceil(w), rows), h: TITLE + box, top: TITLE + inner + (inner ? 2 : 0), titleW, title: TITLE, font }
    }

    /** A node's name size: the outermost largest, each level in a little smaller. */
    titleFont(node) {
        let depth = 0
        for (let at = node.parent; at != null; at = this.model?.nodes.get(at)?.parent) {
            depth++
        }
        return Math.max(15, 32 - 5 * depth)
    }

    /** A stack row's words: its condition, ⚡ when immediate, ✎ when it sets values. */
    rowText(edge, length) {
        return (edge.transition?.mode === "immediate" ? "⚡ " : "") + edgeLabel(edge, length) + (Object.keys(edge.transition?.set ?? {}).length ? " ✎" : "")
    }

    subtitle(node) {
        const activity = node.def?.activity ? this.model.activities.get(node.def.activity) : null
        return activity ? activity.start : ""
    }

    chips(node) {
        const def = node.def
        if (!def) {
            return []
        }
        const found = []
        if (def.requires.length) {
            found.push("requires")
        }
        if (def.ensures.length) {
            found.push("ensures")
        }
        for (const claim of def.claims) {
            found.push(`claims ${claim}`)
        }
        if (def.result) {
            found.push(`→ ${def.result}`)
        }
        return found
    }

    setStyle(style) {
        this.style = style in LAYOUT_STYLES ? style : "curves"
        if (this.model) {
            this.setModel(this.model)
        }
    }

    /** Lay the model out and draw it. ELK lays out in a worker, so the drawing (and the last `show`) follows later. */
    async setModel(model) {
        this.model = model
        this.sizes = new Map()
        const token = (this.drawing = {})
        const box = this.container.getBoundingClientRect()
        const labelWidth = this.labelWidth = (edge) => {
            const context = (this.canvas ??= document.createElement("canvas")).getContext("2d")
            context.font = `10.5px ${getComputedStyle(this.container).getPropertyValue("--mono") || "monospace"}`
            return edgeLabel(edge) && !stacked(edge) ? context.measureText(edgeLabel(edge) + "  ✎⚡").width + 14 : 0
        }
        const aspect = Math.min(2.4, Math.max(0.6, box.width / Math.max(1, box.height)))
        const measure = (node) => {
            if (!this.sizes.has(node.id)) {
                this.sizes.set(node.id, this.measure(node))
            }
            return this.sizes.get(node.id)
        }
        let layout
        try {
            layout = this.style === "curves" || this.style === "arcs" ? layoutGraph(model, measure, labelWidth, aspect, this.style === "arcs") : await layoutElk(model, measure, labelWidth, this.style, aspect)
        } catch (error) {
            console.warn(`${this.style} layout failed, using curves:`, error)
            layout = layoutGraph(model, measure, labelWidth, aspect)
        }
        if (token !== this.drawing) {
            return
        }
        this.world.replaceChildren()
        this.rows = new Map()
        this.nodeEls.clear()
        this.edgeEls.clear()
        this.timerEls.clear()
        this.layout = layout
        this.used = null
        this.colored = 0
        const nodeLayer = svg("g", { class: "nodes" }, this.world)
        const edgeLayer = svg("g", { class: "edges" }, this.world)
        const labelLayer = svg("g", { class: "labels" }, this.world)
        // a hovered node's conditions, over every edge and label
        this.conditionLayer = svg("g", { class: "conditions" }, this.world)
        this.conditionEls = new Map()
        // outermost first, so inner nodes are drawn over their parents
        const depth = (id) => {
            let n = 0
            for (let at = model.nodes.get(id)?.parent; at != null; at = model.nodes.get(at)?.parent) {
                n++
            }
            return n
        }
        const ordered = [...model.nodes.values()].sort((a, b) => depth(a.id) - depth(b.id))
        // Each node with children gets a theme hue, picked from its name, never the same as its parent's or the sibling before it.
        this.hues = new Map()
        for (const node of ordered.filter((one) => one.inside.length)) {
            const siblings = model.nodes.get(node.parent)?.inside.filter((id) => model.nodes.get(id)?.inside.length) ?? []
            const taken = [this.hues.get(node.parent), this.hues.get(siblings[siblings.indexOf(node.id) - 1])]
            let hue = [...node.id].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7) % HUES.length
            while (taken.includes(hue)) {
                hue = (hue + 1) % HUES.length
            }
            this.hues.set(node.id, hue)
        }
        for (const node of ordered.filter((one) => one.kind !== "start")) {
            this.drawNode(nodeLayer, node, layout.rects.get(node.id))
        }
        this.routeAll()
        for (const edge of model.edges) {
            this.drawEdge(edgeLayer, labelLayer, edge)
        }
        this.hovered = null
        this.applyOpen()
        this.userMoved = false
        this.fit()
        if (this.lastShown) {
            this.show(this.lastShown)
        }
    }

    drawNode(layer, node, rect) {
        const size = this.sizes.get(node.id) ?? {}
        const TITLE = size.title ?? 0
        const group = svg("g", { class: `node node-${node.kind}`, "data-id": node.id }, layer)
        if (node.kind === "final") {
            const cx = rect.x + rect.w / 2
            dot(cx, rect.y + 13, 11, `final-ring final-${node.outcome}`, group)
            dot(cx, rect.y + 13, 6, `final-core final-${node.outcome}`, group)
            svg("text", { x: cx, y: rect.y + 37, class: "final-label", "text-anchor": "middle" }, group).textContent = node.outcome
        } else if (node.kind === "compound" || node.kind === "parallel") {
            group.style.setProperty("--hue", HUES[this.hues.get(node.id)])
            const head = this.sizes.get(node.id)?.head ?? HEADER
            // the one outermost node is the whole drawing: no box around it, just its title and stack
            const bare = node.id === this.model.root
            group.classList.toggle("node-root", bare)
            svg("rect", { x: rect.x, y: rect.y, width: rect.w, height: rect.h, class: "box compound-box" }, group)
            svg("text", { x: rect.x + (bare ? 1 : 8), y: rect.y + TITLE - 6, class: "node-name", "font-size": size.font }, group).textContent = node.id
            // closed (not hovered), it hides what is inside and shows just its name, in the middle
            const centered = svg("text", { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, class: "node-name name-centered", "text-anchor": "middle", "dominant-baseline": "middle", "font-size": Math.min(size.font * 1.6, rect.h * 0.6) }, group)
            centered.textContent = node.id
            if (node.kind === "parallel") {
                const tag = svg("g", { class: "parallel-tag" }, group)
                const label = svg("text", { x: rect.x + rect.w - 4, y: rect.y + TITLE - 6, "text-anchor": "end", class: "tag-text" }, tag)
                label.textContent = "∥ parallel"
                const regions = node.inside.map((id) => this.layout.rects.get(id)).filter(Boolean)
                const stacked = regions.length < 2 || regions.every((a, i) => regions.every((b, j) => i === j || a.y + a.h <= b.y || b.y + b.h <= a.y))
                regions.sort((a, b) => (stacked ? a.y - b.y : a.x - b.x))
                for (let i = 1; i < regions.length; i++) {
                    if (stacked) {
                        const y = (regions[i - 1].y + regions[i - 1].h + regions[i].y) / 2
                        svg("line", { x1: rect.x + 8, x2: rect.x + rect.w - 8, y1: y, y2: y, class: "region-split" }, group)
                    } else {
                        const x = (regions[i - 1].x + regions[i - 1].w + regions[i].x) / 2
                        svg("line", { x1: x, x2: x, y1: rect.y + head + 6, y2: rect.y + rect.h - 8, class: "region-split" }, group)
                    }
                }
            }
        } else {
            svg("rect", { x: rect.x, y: rect.y, width: rect.w, height: rect.h, class: "box leaf-box" }, group)
            svg("text", { x: rect.x + 10, y: rect.y + TITLE - 6, class: "node-name", "font-size": size.font }, group).textContent = node.id
            // not hovered, just its name, in the middle
            const centered = svg("text", { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, class: "node-name name-centered", "text-anchor": "middle", "dominant-baseline": "middle", "font-size": size.font }, group)
            centered.textContent = node.id
            let y = rect.y + TITLE + 2
            const sub = this.subtitle(node)
            if (sub) {
                y += 16
                svg("text", { x: rect.x + 10, y, class: "node-sub" }, group).textContent = sub
            }
            const chips = this.chips(node)
            if (chips.length) {
                y += 16
                svg("text", { x: rect.x + 10, y, class: "node-chips" }, group).textContent = chips.join("  ")
            }
            dot(rect.x + rect.w - 6, rect.y + TITLE - 6 - size.font / 3, 4, "run-dot", group)
            svg("text", { x: rect.x + rect.w - 16, y: rect.y + TITLE - 6, "text-anchor": "end", class: "outcome-mark" }, group)
        }
        // its conditions, shown while it is hovered, over every edge
        const overlay = svg("g", { class: "node-conditions" }, this.conditionLayer)
        group.addEventListener("pointerenter", () => {
            overlay.classList.add("shown")
            this.hover(node.id)
        })
        group.addEventListener("pointerleave", () => {
            overlay.classList.remove("shown")
            this.hover(null)
        })
        this.drawStack(group, node, rect, overlay)
        // a countdown under the node, on its own small backing so it reads over lines and container fills
        const timerBg = svg("rect", { class: "timer-bg", visibility: "hidden" }, group)
        const timer = svg("text", { x: rect.x + rect.w - 8, y: rect.y + rect.h + 13, "text-anchor": "end", class: "timer-text" }, group)
        timer.background = timerBg
        this.timerEls.set(node.id, timer)
        group.addEventListener("pointerenter", (event) => this.handlers.onHover({ type: "node", id: node.id }, event))
        group.addEventListener("pointerleave", () => this.handlers.onLeave())
        group.addEventListener("click", (event) => {
            event.stopPropagation()
            this.handlers.onTap({ type: "node", id: node.id }, event)
        })
        this.nodeEls.set(node.id, group)
    }

    /** The node's outgoing conditions, one row each, right-aligned, each ending in the port its edge leaves from. */
    drawStack(group, node, rect, overlay) {
        const top = stackTop(this.sizes.get(node.id) ?? { h: 0 })
        this.rows ??= new Map()
        stackOf(this.model, node.id).forEach((edge, index) => {
            const y = rect.y + top + index * ROW
            const immediate = edge.transition?.mode === "immediate"
            const row = svg("g", { class: `edge-label stack-row edge-label-${edge.kind}${immediate ? " edge-label-immediate" : ""}`, "data-id": edge.id }, group)
            svg("rect", { class: "edge-label-bg", x: rect.x, y, width: rect.w, height: ROW }, row)
            // a line across the box above each row, under the name
            svg("line", { class: "stack-divider", x1: rect.x, x2: rect.x + rect.w, y1: y, y2: y }, row)
            // its words, shown while the node is hovered, over the edges: whole, running out past the box when long
            const words = svg("g", { class: `edge-label row-words edge-label-${edge.kind}${immediate ? " edge-label-immediate" : ""}` }, overlay)
            const bg = svg("rect", { class: "row-words-bg", y, height: ROW }, words)
            const text = svg("text", { x: rect.x + rect.w - 10, y: y + 13, "text-anchor": "end" }, words)
            this.colorNames(text, this.rowText(edge, Infinity))
            const length = text.getComputedTextLength()
            bg.setAttribute("x", Math.min(rect.x, rect.x + rect.w - length - 18))
            bg.setAttribute("width", Math.max(rect.w, length + 18))
            this.conditionEls.set(edge.id, words)
            dot(rect.x + rect.w, y + ROW / 2, 2.5, "stack-port", row)
            row.addEventListener("pointerenter", (event) => {
                event.stopPropagation()
                this.edgeEls.get(edge.id)?.group.classList.add("hover")
                this.handlers.onHover({ type: "edge", id: edge.id }, event)
            })
            row.addEventListener("pointerleave", () => {
                this.edgeEls.get(edge.id)?.group.classList.remove("hover")
                this.handlers.onLeave()
            })
            row.addEventListener("click", (event) => {
                event.stopPropagation()
                this.handlers.onTap({ type: "edge", id: edge.id }, event)
            })
            this.rows.set(edge.id, row)
        })
    }

    /**
     * A stacked edge's curve from its row's port: straight out to the right for LEAD, then in the edge style to its
     * target (ELK's own route from where it put the port, or ours).
     */
    stackedPath(edge, to) {
        const from = this.layout.rects.get(edge.from)
        const port = portOf(this.model, edge, from, stackTop(this.sizes.get(edge.from)))
        const lead = { x: port.x + LEAD, y: port.y }
        if (this.style === "curves" || this.style === "arcs" || this.style === "elk-polyline") {
            // the same lanes in each (apart from other edges, crossing them as little as it can); Arcs swing round each
            // corner as wide as its legs allow, Corners (on ELK's placement of the nodes) keep them sharp
            const corners = this.routed?.get(edge.id) ?? this.routeAround(edge, lead)
            if (corners) {
                if (this.style === "curves") {
                    return flowSegments([port, ...corners], this.blockers(edge))
                }
                return [[port, port, lead, lead], ...roundedSegments(corners, this.style === "arcs" ? Infinity : 0, this.cornerBlockers(edge))]
            }
        }
        if (edge.from === edge.to) {
            // out of the row, then round over the node's top-right corner and down into it
            const corner = { x: from.x + from.w + LEAD + 10, y: from.y - 16 }
            const end = { x: from.x + from.w - 24, y: from.y - 3 }
            return [[port, port, lead, lead], [lead, { x: lead.x + 12, y: lead.y }, { x: corner.x, y: corner.y + 10 }, corner], [corner, { x: corner.x - 10, y: corner.y - 8 }, { x: end.x, y: end.y - 14 }, end]]
        }
        const bends = this.layout.routes?.get(edge.id) ?? []
        const vertical = this.style === "arcs" ? (this.layout.vertical.get(edge.id) ?? false) : null
        const head = [port, port, lead, lead]
        if (to.x <= lead.x + 8) {
            // backward (or overlapping): down past both boxes, along under them, and up into the target's bottom;
            // each row's edge gets its own lane so they don't sit on each other
            const index = stackOf(this.model, edge.from).indexOf(edge)
            const lane = Math.max(from.y + from.h, to.y + to.h) + 10 + index * 6
            const x = Math.min(to.x + to.w - 14, Math.max(to.x + 14, to.x + to.w / 2 + index * 6))
            const below = lane > to.y + to.h
            return [head, ...roundedSegments([lead, { x: lead.x + index * 4, y: lead.y }, { x: lead.x + index * 4, y: lane }, { x, y: lane }, { x, y: below ? to.y + to.h + 3 : to.y - 3 }])]
        }
        if (vertical === false) {
            return [head, ...edgeShape(this.model, { ...edge, from: `${edge.id}::lead` }, { ...lead, w: 0, h: 0 }, to, bends, () => 0, false)]
        }
        // forward: corners, rounded: across to a turn halfway, along to the target's height, and into its left side
        const end = { x: to.x - 3, y: Math.min(to.y + to.h - 8, Math.max(to.y + 8, lead.y)) }
        const turn = bends.length ? Math.min(...bends.map((bend) => bend.x)) : (lead.x + end.x) / 2
        const mid = Math.max(lead.x + 6, Math.min(end.x - 6, turn))
        return [head, ...roundedSegments([lead, { x: mid, y: lead.y }, { x: mid, y: end.y }, end])]
    }

    /**
     * The corners of a stacked edge's route from `lead` to its target's box, around every node it is not part of (a
     * node it starts or ends inside counts only by its header), within the innermost node holding both its ends.
     * Tries the edges left in order; null when there is no way through.
     */
    routeAround(edge, lead) {
        const rects = this.layout.rects
        const ancestors = (id) => {
            const found = []
            for (let at = this.model.nodes.get(id)?.parent; at != null; at = this.model.nodes.get(at)?.parent) {
                found.push(at)
            }
            return found
        }
        const outside = new Set([...ancestors(edge.from), ...ancestors(edge.to)])
        // a node's whole box; a node holding an end counts only by its header (its name and conditions)
        const shapes = (id) => {
            const rect = rects.get(id)
            const size = this.sizes.get(id)
            if (!rect || !size?.titleW) {
                return rect ? [rect] : []
            }
            return outside.has(id) ? [{ x: rect.x, y: rect.y, w: rect.w, h: size.head ?? size.title }] : [rect]
        }
        const obstacles = [...this.model.nodes.values()].filter((node) => node.kind !== "start").flatMap((node) => shapes(node.id))
        // the innermost node holding both ends (not one of the ends), and the room inside its box
        const fromUp = ancestors(edge.from)
        const toUp = new Set(ancestors(edge.to))
        const holder = fromUp.find((id) => toUp.has(id))
        const all = { x: -60, y: -60, w: this.layout.width + 120, h: this.layout.height + 120 }
        const held = holder && holder !== this.model.root ? rects.get(holder) : null
        const heldTitle = this.sizes.get(holder)?.title ?? 0
        const region = held ? { x: held.x + 1, y: held.y + heldTitle + 1, w: held.w - 2, h: held.h - heldTitle - 2 } : all
        // where it may arrive: the left side at its own height, the top right of the name, the bottom, the right side
        const to = rects.get(edge.to)
        const toSize = this.sizes.get(edge.to)
        const box = to
        const self = edge.from === edge.to
        // an edge may come in anywhere along the left side, the top (clear of the name) or the bottom, spaced out, and
        // a spot another edge already comes in at costs extra, so arrowheads don't pile onto one point
        const along = (low, high, step) => {
            const count = Math.max(1, Math.floor((high - low) / step))
            return Array.from({ length: count + 1 }, (_, i) => low + ((high - low) * i) / count)
        }
        this.used ??= { h: new Map(), v: new Map(), ends: [] }
        const taken = (end) => (this.used.ends.some((other) => Math.hypot(other.x - end.x, other.y - end.y) < 10) ? 400 : 0)
        // `gap`: how far out from the target the last turn comes, so the arrowhead sits on a straight run
        const goalsAt = (gap) => {
            const goals = []
            const offer = (goal) => goals.push({ ...goal, cost: goal.cost + taken({ x: goal.end.x ?? goal.x, y: goal.end.y ?? goal.y }) })
            if (!self) {
                for (const y of along(box.y + 8, box.y + box.h - 8, 14)) {
                    offer({ x: box.x - gap, y, dir: 0, cost: Math.abs(y - lead.y) * 0.2, end: { x: box.x - 3 } })
                }
            }
            const topX = box.x + (toSize?.titleW ?? 0) + 24
            for (const x of self ? [box.x + box.w - 12] : topX < box.x + box.w - 8 ? along(topX, box.x + box.w - 12, 16) : []) {
                offer({ x, y: box.y - gap, dir: 1, cost: 12, end: { y: box.y - 3 } })
            }
            for (const x of self ? [box.x + box.w / 2] : along(box.x + 12, box.x + box.w - 12, 16)) {
                offer({ x, y: box.y + box.h + gap, dir: 3, cost: 12, end: { y: box.y + box.h + 3 } })
            }
            if (!self) {
                offer({ x: box.x + box.w + gap, y: box.y + box.h - 7, dir: 2, cost: 90, end: { x: box.x + box.w + 3 } })
            }
            return goals
        }
        // the last turn 30px out, or 13px where the nodes sit too close for that
        let goals = []
        let corners = null
        for (const gap of [30, 13]) {
            goals = goalsAt(gap)
            corners = route(lead, 0, goals, obstacles, region, this.used) ?? (held ? route(lead, 0, goals, obstacles, all, this.used) : null)
            if (corners) {
                break
            }
        }
        if (!corners) {
            return null
        }
        const last = corners.at(-1)
        const goal = goals.find((one) => Math.abs(one.x - last.x) < 1 && Math.abs(one.y - last.y) < 1) ?? goals[0]
        const end = { x: goal.end.x ?? last.x, y: goal.end.y ?? last.y }
        this.used.ends.push(end)
        return [lead, ...corners.slice(1), end]
    }

    /**
     * Curves, Arcs and Corners: every stacked edge's route, worked out before any is drawn. Each is routed once in order, then
     * routed again with all the others in place (its own first route taken out), so an early edge isn't stuck with
     * the inner lane a later one needed: nested bends end up nested, not crossing.
     */
    routeAll() {
        this.routed = new Map()
        if (!["curves", "arcs", "elk-polyline"].includes(this.style)) {
            return
        }
        const leads = new Map()
        for (const edge of this.model.edges.filter((one) => stacked(one) && one.kind === "transition")) {
            const from = this.layout.rects.get(edge.from)
            if (from && this.layout.rects.get(edge.to)) {
                const port = portOf(this.model, edge, from, stackTop(this.sizes.get(edge.from)))
                leads.set(edge, { x: port.x + LEAD, y: port.y })
            }
        }
        for (let pass = 0; pass < PASSES; pass++) {
            for (const [edge, lead] of leads) {
                const before = this.routed.get(edge.id)
                if (before) {
                    this.forget(before)
                }
                const corners = this.routeAround(edge, lead)
                if (corners) {
                    this.routed.set(edge.id, corners)
                } else {
                    this.routed.delete(edge.id)
                }
            }
        }
    }

    /** Take a route's stretches and its arrival spot back out of what later routes keep clear of. */
    forget(points) {
        const end = points.at(-1)
        this.used.ends = this.used.ends.filter((other) => other !== end)
        // the stretches route() recorded: between its corners, which stop at the goal (the last point is the arrival)
        const corners = points.slice(0, -1)
        for (let n = 1; n < corners.length; n++) {
            const [a, b] = [corners[n - 1], corners[n]]
            const [lines, at, span] = a.y === b.y ? [this.used.h, a.y, [a.x, b.x]] : [this.used.v, a.x, [a.y, b.y]]
            const [low, high] = span.sort((m, k) => m - k)
            const spans = lines.get(at) ?? []
            const index = spans.findIndex(([m, k]) => m === low && k === high)
            if (index >= 0) {
                spans.splice(index, 1)
            }
        }
    }

    /**
     * The node under the pointer (or null). Read on the next frame, so moving from a container onto its child (a leave
     * then an enter) never closes the container in between.
     */
    hover(id) {
        this.hovered = id
        cancelAnimationFrame(this.openFrame)
        this.openFrame = requestAnimationFrame(() => this.applyOpen())
    }

    /**
     * Nodes are closed (just their name in the middle; a container's inside hidden) except the hovered one, the ones
     * around it, and the outermost. An edge hides when both its ends are hidden.
     */
    applyOpen() {
        const open = new Set([this.model.root])
        for (let at = this.hovered; at != null; at = this.model.nodes.get(at)?.parent) {
            open.add(at)
        }
        const hidden = (id) => {
            for (let at = this.model.nodes.get(id)?.parent; at != null; at = this.model.nodes.get(at)?.parent) {
                if (!open.has(at)) {
                    return true
                }
            }
            return false
        }
        for (const [id, element] of this.nodeEls) {
            const node = this.model.nodes.get(id)
            element.classList.toggle("closed", node?.kind !== "final" && !open.has(id))
            element.classList.toggle("tucked", hidden(id))
        }
        for (const edge of this.model.edges) {
            const element = this.edgeEls.get(edge.id)
            const tucked = edge.kind === "initial" ? hidden(edge.to) : hidden(edge.from) && hidden(edge.to)
            element?.group.classList.toggle("tucked", tucked)
            element?.label?.classList.toggle("tucked", tucked)
        }
    }

    /** The boxes an edge must not run through: every node it neither starts in, ends in, nor sits inside. */
    blockers(edge) {
        const skip = new Set([edge.from, edge.to])
        for (const id of [edge.from, edge.to]) {
            for (let at = this.model.nodes.get(id)?.parent; at != null; at = this.model.nodes.get(at)?.parent) {
                skip.add(at)
            }
        }
        return [...this.layout.rects].filter(([id]) => !skip.has(id)).map(([, rect]) => rect)
    }

    /** What a rounded corner keeps clear of: the blockers, and the boxes the edge leaves and enters too. */
    cornerBlockers(edge) {
        return [...this.blockers(edge), ...[edge.from, edge.to].map((id) => this.layout.rects.get(id)).filter(Boolean)]
    }

    /** Whether a drawn edge runs through the box of a node it neither starts in, ends in, nor sits inside. */
    crossesNode(edge, path) {
        const boxes = this.blockers(edge)
        const length = path.getTotalLength()
        for (let along = 0; along <= length; along += 3) {
            const p = path.getPointAtLength(along)
            if (boxes.some((box) => p.x > box.x + 2 && p.x < box.x + box.w - 2 && p.y > box.y + 2 && p.y < box.y + box.h - 2)) {
                return true
            }
        }
        return false
    }

    drawEdge(edgeLayer, labelLayer, edge) {
        const to = this.layout.rects.get(edge.to)
        let d
        let labelAt = null
        let labelShift = null
        if (edge.kind === "initial") {
            // where a container starts: an arrow from just below the middle of its title to the entry node
            const box = this.layout.rects.get(edge.node)
            if (!box || !to) {
                return
            }
            // from the top-left corner of its inside, under its header
            const start = { x: box.x + 6, y: box.y + (this.sizes.get(edge.node)?.head ?? 0) + 6 }
            const end = boundaryPoint(to, start, 3)
            d = `M${start.x},${start.y} L${end.x.toFixed(1)},${end.y.toFixed(1)}`
        } else if (stacked(edge) && (!this.layout.paths || this.style === "elk-polyline")) {
            if (!to || !this.layout.rects.get(edge.from)) {
                return
            }
            d = segmentsPath(this.stackedPath(edge, to))
        } else if (this.layout.paths) {
            const drawn = this.layout.paths.get(edge.id)
            if (!drawn?.d) {
                return
            }
            d = drawn.d
            labelAt = drawn.label
        } else {
            const from = this.layout.rects.get(edge.from)
            if (!from || !to) {
                return
            }
            const vertical = this.style === "arcs" ? (this.layout.vertical.get(edge.id) ?? false) : null
            const segments = edgeShape(this.model, edge, from, to, this.layout.routes.get(edge.id) ?? [], this.labelWidth, vertical)
            d = segmentsPath(segments)
            const sampled = sampleSegments(segments)
            labelAt = sampled.mid
            labelShift = sampled.side
        }
        const immediate = edge.transition?.mode === "immediate"
        const cls = ["edge", `edge-${edge.kind}`, immediate ? "edge-immediate" : ""].join(" ")
        const group = svg("g", { class: cls, "data-id": edge.id }, edgeLayer)
        if (edge.kind === "transition" && !immediate) {
            // its own color, shared with its row's port so the two read as one
            const color = EDGE_COLORS[this.colored++ % EDGE_COLORS.length]
            group.style.setProperty("--edge-color", color)
            this.rows?.get(edge.id)?.style.setProperty("--edge-color", color)
        }
        const path = svg("path", { d, class: "edge-line" }, group)
        const hit = svg("path", { d, class: "edge-hit" }, group)
        if (edge.kind !== "initial" && stacked(edge) && this.crossesNode(edge, path)) {
            // an edge whose curve would run over a node takes the routed way round it, with rounded corners
            const start = path.getPointAtLength(0)
            const lead = { x: start.x + LEAD, y: start.y }
            const corners = this.routed?.get(edge.id) ?? this.routeAround(edge, lead)
            if (corners) {
                d = segmentsPath([[start, start, lead, lead], ...roundedSegments(corners, CURVE_RADIUS, this.cornerBlockers(edge))])
                path.setAttribute("d", d)
                hit.setAttribute("d", d)
            }
        }
        // The arrowhead is its own triangle: its tip on the curve's end, its base 10px back along the curve, and the
        // line stopping at the middle of that base, so the line always meets the head square-on.
        const length = path.getTotalLength()
        if (length > 12) {
            const tip = path.getPointAtLength(length)
            const base = path.getPointAtLength(length - 10)
            const ux = (tip.x - base.x) / (Math.hypot(tip.x - base.x, tip.y - base.y) || 1)
            const uy = (tip.y - base.y) / (Math.hypot(tip.x - base.x, tip.y - base.y) || 1)
            const corners = [[tip.x, tip.y], [tip.x - ux * 10 - uy * 5, tip.y - uy * 10 + ux * 5], [tip.x - ux * 10 + uy * 5, tip.y - uy * 10 - ux * 5]]
            svg("polygon", { points: corners.map((corner) => corner.map((value) => value.toFixed(1)).join(",")).join(" "), class: "arrow-head" }, group)
            if (!["initial", "requires", "ensures"].includes(edge.kind)) {
                path.style.strokeDasharray = `${length - 10} ${length}`
            }
        }
        const label = stacked(edge) ? "" : edgeLabel(edge)
        let labelGroup = this.rows?.get(edge.id) ?? null
        if (label) {
            const mid = labelAt ?? path.getPointAtLength(path.getTotalLength() / 2)
            labelGroup = svg("g", { class: `edge-label edge-label-${edge.kind}${immediate ? " edge-label-immediate" : ""}`, "data-id": edge.id }, labelLayer)
            const background = svg("rect", { class: "edge-label-bg" }, labelGroup)
            const text = svg("text", { x: mid.x, y: mid.y + 4, "text-anchor": "middle" }, labelGroup)
            this.colorNames(text, (immediate ? "⚡ " : "") + label + (Object.keys(edge.transition?.set ?? {}).length ? " ✎" : ""))
            const w = text.getComputedTextLength() || text.textContent.length * 6.4
            const box = labelShift ? labelBox(mid, w + 14, labelShift) : { x: mid.x - w / 2 - 7, y: mid.y - 9, w: w + 14, h: 18 }
            text.setAttribute("x", box.x + box.w / 2)
            text.setAttribute("y", box.y + 13)
            for (const [key, value] of Object.entries({ x: box.x, y: box.y, width: box.w, height: box.h })) {
                background.setAttribute(key, value)
            }
            const tip = labelTip(box, nearestPoint(path, { x: box.x + box.w / 2, y: box.y + box.h / 2 }))
            if (tip) {
                labelGroup.insertBefore(svg("path", { d: tip, class: "edge-label-tip" }), text)
            }
        }
        for (const element of [hit, stacked(edge) ? null : labelGroup].filter(Boolean)) {
            element.addEventListener("pointerenter", (event) => {
                group.classList.add("hover")
                this.handlers.onHover({ type: "edge", id: edge.id }, event)
            })
            element.addEventListener("pointerleave", () => {
                group.classList.remove("hover")
                this.handlers.onLeave()
            })
            element.addEventListener("click", (event) => {
                event.stopPropagation()
                this.handlers.onTap({ type: "edge", id: edge.id }, event)
            })
        }
        this.edgeEls.set(edge.id, { group, path, label: labelGroup })
        // on an edge inside a container, the container stays open
        // hovered, its condition shows in its row (over the edges), and the container around it stays open
        group.addEventListener("pointerenter", () => {
            this.conditionEls.get(edge.id)?.classList.add("lit")
            this.hover(edge.from ?? edge.node ?? null)
        })
        group.addEventListener("pointerleave", () => {
            this.conditionEls.get(edge.id)?.classList.remove("lit")
            this.hover(null)
        })
    }

    /** Write a label's text, with each blackboard name in it drawn in its kind's color (as in the blackboard). */
    colorNames(text, content) {
        const names = namesFor(this.model, {})
        let at = 0
        for (const match of content.matchAll(/[A-Za-z_][\w.]*/g)) {
            const parts = match[0].split(".")
            const name = parts.map((_, i) => parts.slice(0, parts.length - i).join(".")).find((prefix) => names.known.has(prefix))
            if (!name) {
                continue
            }
            text.append(content.slice(at, match.index))
            svg("tspan", { class: `lbl-${names.kindOf(name)}` }, text).textContent = match[0]
            at = match.index + match[0].length
        }
        text.append(content.slice(at))
    }

    /**
     * Show a step. With `frames` (the steps since the last one shown), they play in order through a queue: each one's
     * edge, then the nodes it lit, before the next begins. More than FIRE_BACKLOG waiting (a fast loop) are played at
     * once and the queue starts over, so it never falls behind. Without frames it jumps straight there.
     * @param {import("./history.js").Step} step
     * @param {{ frames?: { step: any, fired: string[], entered: string[] }[] }} [animate]
     */
    show(step, animate = {}) {
        this.lastShown = step
        if (!this.model || !step) {
            return
        }
        if (animate.frames) {
            if (!animate.frames.length && !this.busy && !this.frames.length) {
                this.applyState(step)
                return
            }
            this.frames.push(...animate.frames)
            if (this.frames.length > FIRE_BACKLOG) {
                const burst = this.frames.splice(0)
                this.stopQueue()
                burst.flatMap((frame) => frame.fired).forEach((id) => this.play(id))
                this.applyState(burst.at(-1).step, burst.flatMap((frame) => frame.entered))
                return
            }
            this.pump()
            return
        }
        this.frames = []
        this.stopQueue()
        this.applyState(step)
    }

    stopQueue() {
        clearTimeout(this.busy)
        this.busy = null
    }

    pump() {
        if (this.busy || !this.frames.length) {
            return
        }
        const frame = this.frames.shift()
        if (!frame.fired.length || document.hidden) {
            this.applyState(frame.step, frame.entered)
            this.pump()
            return
        }
        frame.fired.forEach((id) => this.play(id))
        // the nodes light as the spark arrives, and the next frame waits for this one to finish
        this.busy = setTimeout(() => {
            this.applyState(frame.step, frame.entered)
            this.busy = setTimeout(() => {
                this.busy = null
                this.pump()
            }, FIRE_MS * 0.35)
        }, FIRE_MS * 0.65)
    }

    /** Light the nodes active at a step, and flash the ones it entered. */
    applyState(step, entered = []) {
        const active = new Set(step.active)
        const running = new Map()
        for (const call of step.calls) {
            if (call.kind === "start" && call.node) {
                running.set(call.node, call.phase)
            }
        }
        const outcomes = new Map()
        for (const [node, outcome] of step.outcomes) {
            outcomes.set(node, outcome)
        }
        for (const [id, element] of this.nodeEls) {
            const node = this.model.nodes.get(id)
            let lit = active.has(id)
            if (node.kind === "final") {
                lit = outcomes.get(node.parent) === node.outcome
            }
            element.classList.toggle("active", lit)
            element.classList.toggle("running", running.get(id) === "sent")
            element.classList.toggle("held", running.get(id) === "held")
            const mark = element.querySelector(".outcome-mark")
            if (mark) {
                const outcome = outcomes.get(id)
                mark.textContent = outcome === "succeeded" ? "✓" : outcome === "failed" ? "✗" : running.get(id) === "held" ? "held" : ""
                mark.dataset.outcome = outcome ?? (running.get(id) === "held" ? "held" : "")
            }
        }
        for (const id of entered) {
            const element = this.nodeEls.get(id)
            if (element) {
                element.classList.remove("entered")
                void element.getBoundingClientRect()
                element.classList.add("entered")
            }
        }
        this.timers = step.timers
        this.timerClock = step
        this.drawTimers()
    }

    /** Countdowns under the nodes with an `after` timer, as of `now` (wall seconds). */
    drawTimers(now) {
        const due = new Map()
        for (const timer of this.timers ?? []) {
            if (timer.kind === "after") {
                due.set(timer.node, Math.min(due.get(timer.node) ?? Infinity, timer.due))
            }
        }
        const at = now ?? this.timerClock?.time ?? Date.now() / 1000
        for (const [id, element] of this.timerEls) {
            const when = due.get(id)
            const text = when == null ? "" : `⏱ ${Math.max(0, when - at).toFixed(1)}s`
            if (element.textContent === text) {
                continue
            }
            element.textContent = text
            element.background.setAttribute("visibility", text ? "visible" : "hidden")
            if (text) {
                const box = element.getBBox()
                for (const [key, value] of Object.entries({ x: box.x - 4, y: box.y - 1, width: box.width + 8, height: box.height + 2 })) {
                    element.background.setAttribute(key, value)
                }
            }
        }
    }

    /** Play a transition along its edge: the line and label flash, and a spark runs from its start to its end. */
    play(edgeId) {
        const edge = this.edgeEls.get(edgeId)
        if (!edge) {
            return
        }
        for (const element of [edge.group, edge.label].filter(Boolean)) {
            element.classList.remove("fired")
            void element.getBoundingClientRect()
            element.classList.add("fired")
        }
        const spark = dot(0, 0, 3.5, "spark", edge.group)
        const length = edge.path.getTotalLength()
        const started = performance.now()
        const duration = FIRE_MS * 0.65
        const step = (now) => {
            const t = Math.min(1, (now - started) / duration)
            const eased = 1 - (1 - t) ** 3
            const point = edge.path.getPointAtLength(length * eased)
            spark.setAttribute("x", point.x - 3.5)
            spark.setAttribute("y", point.y - 3.5)
            if (t < 1) {
                requestAnimationFrame(step)
            } else {
                spark.remove()
            }
        }
        requestAnimationFrame(step)
    }

    /** Pick out edges (e.g. the ones that set a key), or none. */
    highlight(edgeIds = [], nodeIds = []) {
        const edges = new Set(edgeIds)
        const nodes = new Set(nodeIds)
        for (const [id, edge] of this.edgeEls) {
            edge.group.classList.toggle("picked", edges.has(id))
            edge.label?.classList.toggle("picked", edges.has(id))
            this.conditionEls.get(id)?.classList.toggle("picked", edges.has(id))
        }
        for (const [id, element] of this.nodeEls) {
            element.classList.toggle("picked", nodes.has(id))
        }
        this.root.classList.toggle("picking", edges.size + nodes.size > 0)
    }

    apply() {
        this.world.setAttribute("transform", `translate(${this.view.x},${this.view.y}) scale(${this.view.k})`)
    }

    fit() {
        if (!this.layout) {
            return
        }
        const box = this.container.getBoundingClientRect()
        // edge labels and loops can reach past the root's box, so fit what was actually drawn
        const drawn = this.world.getBBox()
        const margin = 16
        const bottom = 52 // the edge-style setting sits in the bottom-left corner
        const k = Math.min(2, (box.width - margin * 2) / Math.max(1, drawn.width), (box.height - margin - bottom) / Math.max(1, drawn.height))
        this.view = {
            k,
            x: (box.width - drawn.width * k) / 2 - drawn.x * k,
            y: margin + (box.height - margin - bottom - drawn.height * k) / 2 - drawn.y * k,
        }
        this.apply()
    }

    setUpPanZoom() {
        const pointers = new Map()
        let last = null
        this.root.addEventListener("wheel", (event) => {
            event.preventDefault()
            const box = this.root.getBoundingClientRect()
            this.zoomAt(event.clientX - box.left, event.clientY - box.top, Math.exp(-event.deltaY * 0.0015))
        }, { passive: false })
        this.root.addEventListener("pointerdown", (event) => {
            pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
            last = null
        })
        addEventListener("pointermove", (event) => {
            if (!pointers.has(event.pointerId)) {
                return
            }
            const before = [...pointers.values()]
            pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
            const now = [...pointers.values()]
            if (now.length === 1) {
                const moved = { x: now[0].x - before[0].x, y: now[0].y - before[0].y }
                if (Math.abs(moved.x) + Math.abs(moved.y) > 0) {
                    this.view.x += moved.x
                    this.view.y += moved.y
                    this.userMoved = true
                    this.apply()
                }
            } else if (now.length === 2) {
                const spread = Math.hypot(now[0].x - now[1].x, now[0].y - now[1].y)
                const box = this.root.getBoundingClientRect()
                const cx = (now[0].x + now[1].x) / 2 - box.left
                const cy = (now[0].y + now[1].y) / 2 - box.top
                if (last) {
                    this.zoomAt(cx, cy, spread / last)
                }
                last = spread
            }
        })
        const release = (event) => {
            pointers.delete(event.pointerId)
            last = null
        }
        addEventListener("pointerup", release)
        addEventListener("pointercancel", release)
        this.root.addEventListener("click", () => this.handlers.onTap(null))
    }

    zoomAt(x, y, factor) {
        const k = Math.min(4, Math.max(0.15, this.view.k * factor))
        const ratio = k / this.view.k
        this.view = { k, x: x - (x - this.view.x) * ratio, y: y - (y - this.view.y) * ratio }
        this.userMoved = true
        this.apply()
    }
}
