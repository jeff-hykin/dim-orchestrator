// The state machine drawn as SVG: nested nodes, transitions and fallbacks as edges, the active nodes lit, and every
// transition the engine takes played along its edge.

import { namesFor } from "./details.js"
import { boundaryPoint, edgeShape, HEADER, labelBox, layoutGraph, PAD, segmentsPath } from "./layout.js"
import { layoutElk } from "./layout_elk.js"

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

// container colors: blends of the skin's own colors, kept apart from the kind colors (vars, signals, ...), --primary
// (the active state) and --danger (faults)
const HUES = [
    "color-mix(in oklch, var(--info) 55%, var(--ok))",
    "color-mix(in oklch, var(--accent-alt) 55%, var(--danger))",
    "color-mix(in oklch, var(--warn) 50%, var(--danger))",
    "color-mix(in oklch, var(--info) 50%, var(--accent-alt))",
    "color-mix(in oklch, var(--ok) 50%, var(--warn))",
]

const short = (text, length = 26) => (text.length > length ? `${text.slice(0, length - 1)}…` : text)

/** The words an edge's label carries. */
export function edgeLabel(edge) {
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
        parts.push("always")
    }
    return short(parts.join(" "))
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
        const defs = svg("defs", {}, this.root)
        for (const [id, cls] of [["arrow", "arrow"], ["arrow-hot", "arrow hot"], ["arrow-fallback", "arrow fallback"]]) {
            const marker = svg("marker", { id: `orch-${id}`, viewBox: "0 0 10 10", refX: 10, refY: 5, markerWidth: 10, markerHeight: 10, markerUnits: "userSpaceOnUse", orient: "auto-start-reverse" }, defs)
            svg("path", { d: "M0,0 L10,5 L0,10 z", class: cls }, marker)
        }
        this.world = svg("g", { class: "world" }, this.root)
        this.view = { x: 0, y: 0, k: 1 }
        this.userMoved = false
        this.nodeEls = new Map()
        this.edgeEls = new Map()
        this.timerEls = new Map()
        this.style = "curves"
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
        if (node.kind === "compound" || node.kind === "parallel") {
            return { w: width(node.id, `600 13px ${sans}`) + (node.kind === "parallel" ? 90 : 40), h: HEADER }
        }
        const sub = this.subtitle(node)
        const chips = this.chips(node).join("  ")
        const w = Math.max(width(node.id, `600 13px ${sans}`), sub ? width(sub, `11px ${mono}`) : 0, chips ? width(chips, `10px ${mono}`) + 16 : 0)
        return { w: Math.ceil(w + 28), h: 30 + (sub ? 16 : 0) + (chips ? 16 : 0) }
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
        const token = (this.drawing = {})
        const box = this.container.getBoundingClientRect()
        const labelWidth = this.labelWidth = (edge) => {
            const context = (this.canvas ??= document.createElement("canvas")).getContext("2d")
            context.font = `10.5px ${getComputedStyle(this.container).getPropertyValue("--mono") || "monospace"}`
            return edgeLabel(edge) ? context.measureText(edgeLabel(edge) + "  ✎⚡").width + 14 : 0
        }
        const aspect = Math.min(2.4, Math.max(0.6, box.width / Math.max(1, box.height)))
        const measure = (node) => this.measure(node)
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
        this.nodeEls.clear()
        this.edgeEls.clear()
        this.timerEls.clear()
        this.layout = layout
        const nodeLayer = svg("g", { class: "nodes" }, this.world)
        const edgeLayer = svg("g", { class: "edges" }, this.world)
        const labelLayer = svg("g", { class: "labels" }, this.world)
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
        for (const edge of model.edges) {
            this.drawEdge(edgeLayer, labelLayer, edge)
        }
        this.userMoved = false
        this.fit()
        if (this.lastShown) {
            this.show(this.lastShown)
        }
    }

    drawNode(layer, node, rect) {
        const group = svg("g", { class: `node node-${node.kind}`, "data-id": node.id }, layer)
        if (node.kind === "final") {
            const cx = rect.x + rect.w / 2
            dot(cx, rect.y + 13, 11, `final-ring final-${node.outcome}`, group)
            dot(cx, rect.y + 13, 6, `final-core final-${node.outcome}`, group)
            svg("text", { x: cx, y: rect.y + 37, class: "final-label", "text-anchor": "middle" }, group).textContent = node.outcome
        } else if (node.kind === "compound" || node.kind === "parallel") {
            group.style.setProperty("--hue", HUES[this.hues.get(node.id)])
            svg("rect", { x: rect.x, y: rect.y, width: rect.w, height: rect.h, class: "box compound-box" }, group)
            svg("rect", { x: rect.x, y: rect.y, width: rect.w, height: HEADER, class: "compound-head" }, group)
            svg("text", { x: rect.x + 14, y: rect.y + 20, class: "node-name" }, group).textContent = node.id
            if (node.kind === "parallel") {
                const tag = svg("g", { class: "parallel-tag" }, group)
                const label = svg("text", { x: rect.x + rect.w - 14, y: rect.y + 20, "text-anchor": "end", class: "tag-text" }, tag)
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
                        svg("line", { x1: x, x2: x, y1: rect.y + HEADER + 6, y2: rect.y + rect.h - 8, class: "region-split" }, group)
                    }
                }
            }
        } else {
            svg("rect", { x: rect.x, y: rect.y, width: rect.w, height: rect.h, class: "box leaf-box" }, group)
            svg("text", { x: rect.x + 14, y: rect.y + 20, class: "node-name" }, group).textContent = node.id
            let y = rect.y + 20
            const sub = this.subtitle(node)
            if (sub) {
                y += 16
                svg("text", { x: rect.x + 14, y, class: "node-sub" }, group).textContent = sub
            }
            const chips = this.chips(node)
            if (chips.length) {
                y += 16
                svg("text", { x: rect.x + 14, y, class: "node-chips" }, group).textContent = chips.join("  ")
            }
            dot(rect.x + rect.w - 11, rect.y + 11, 4, "run-dot", group)
            svg("text", { x: rect.x + rect.w - 22, y: rect.y + 15, "text-anchor": "end", class: "outcome-mark" }, group)
        }
        const timer = svg("text", { x: rect.x + rect.w - 8, y: rect.y + rect.h + 13, "text-anchor": "end", class: "timer-text" }, group)
        this.timerEls.set(node.id, timer)
        group.addEventListener("pointerenter", (event) => this.handlers.onHover({ type: "node", id: node.id }, event))
        group.addEventListener("pointerleave", () => this.handlers.onLeave())
        group.addEventListener("click", (event) => {
            event.stopPropagation()
            this.handlers.onTap({ type: "node", id: node.id }, event)
        })
        this.nodeEls.set(node.id, group)
    }

    drawEdge(edgeLayer, labelLayer, edge) {
        const to = this.layout.rects.get(edge.to)
        let d
        let labelAt = null
        let labelFraction = 0.5
        let labelShift
        if (edge.kind === "initial") {
            // where a container starts: an arrow from its top-left corner to the entry node
            const box = this.layout.rects.get(edge.node)
            if (!box || !to) {
                return
            }
            const corner = { x: box.x + 6, y: box.y + HEADER + 6 }
            const end = boundaryPoint(to, corner, 3)
            d = `M${corner.x},${corner.y} L${end.x.toFixed(1)},${end.y.toFixed(1)}`
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
            labelFraction = segments.labelAt ?? 0.5
            labelShift = segments.labelShift
        }
        const immediate = edge.transition?.mode === "immediate"
        const cls = ["edge", `edge-${edge.kind}`, immediate ? "edge-immediate" : ""].join(" ")
        const group = svg("g", { class: cls, "data-id": edge.id }, edgeLayer)
        const marker = edge.kind === "requires" || edge.kind === "ensures" ? "arrow-fallback" : "arrow"
        const path = svg("path", { d, class: "edge-line", "marker-end": `url(#orch-${marker})` }, group)
        const hit = svg("path", { d, class: "edge-hit" }, group)
        if (edge.kind === "transition") {
            // the line stops a few pixels inside the arrowhead, where the head is wider than the line, so none of it shows past the tip
            const length = path.getTotalLength()
            path.style.strokeDasharray = `${Math.max(0, length - 4)} ${length}`
        }
        const label = edgeLabel(edge)
        let labelGroup = null
        if (label) {
            const mid = labelAt ?? path.getPointAtLength(path.getTotalLength() * labelFraction)
            labelGroup = svg("g", { class: `edge-label edge-label-${edge.kind}${immediate ? " edge-label-immediate" : ""}`, "data-id": edge.id }, labelLayer)
            const background = svg("rect", { class: "edge-label-bg" }, labelGroup)
            const text = svg("text", { x: mid.x, y: mid.y + 4, "text-anchor": "middle" }, labelGroup)
            this.colorNames(text, (immediate ? "⚡ " : "") + label + (Object.keys(edge.transition?.set ?? {}).length ? " ✎" : ""))
            const w = text.getComputedTextLength() || text.textContent.length * 6.4
            if (labelShift) {
                // beside its lane rather than on it
                const box = labelBox(mid, w + 14, labelShift)
                text.setAttribute("x", box.x + box.w / 2)
                text.setAttribute("y", box.y + 13)
                for (const [key, value] of Object.entries({ x: box.x, y: box.y, width: box.w, height: 18 })) {
                    background.setAttribute(key, value)
                }
            } else {
                for (const [key, value] of Object.entries({ x: mid.x - w / 2 - 7, y: mid.y - 9, width: w + 14, height: 18 })) {
                    background.setAttribute(key, value)
                }
            }
        }
        for (const element of [hit, labelGroup].filter(Boolean)) {
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
     * Light the nodes active at a step; when `fired` is given, play those edges and flash the nodes entered.
     * @param {import("./history.js").Step} step
     * @param {{ fired?: string[], entered?: string[] }} [animate]
     */
    show(step, animate = {}) {
        this.lastShown = step
        if (!this.model || !step) {
            return
        }
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
        for (const id of animate.entered ?? []) {
            const element = this.nodeEls.get(id)
            if (element) {
                element.classList.remove("entered")
                void element.getBoundingClientRect()
                element.classList.add("entered")
            }
        }
        for (const id of animate.fired ?? []) {
            this.fire(id)
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
            element.textContent = when == null ? "" : `⏱ ${Math.max(0, when - at).toFixed(1)}s`
        }
    }

    fire(edgeId) {
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
        const duration = 650
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
