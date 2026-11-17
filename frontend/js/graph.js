// The state machine drawn as SVG: nested nodes, transitions and fallbacks as edges, the active nodes lit, and every
// transition the engine takes played along its edge.

import { boundaryPoint, HEADER, layoutGraph, smoothPath } from "./layout.js"

const SVG = "http://www.w3.org/2000/svg"
const svg = (tag, attrs = {}, parent) => {
    const element = document.createElementNS(SVG, tag)
    for (const [key, value] of Object.entries(attrs)) {
        element.setAttribute(key, String(value))
    }
    parent?.append(element)
    return element
}

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
            const marker = svg("marker", { id: `orch-${id}`, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, defs)
            svg("path", { d: "M0,0 L10,5 L0,10 z", class: cls }, marker)
        }
        this.world = svg("g", { class: "world" }, this.root)
        this.view = { x: 0, y: 0, k: 1 }
        this.userMoved = false
        this.nodeEls = new Map()
        this.edgeEls = new Map()
        this.timerEls = new Map()
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
        return activity ? `${activity.name} → ${activity.start}` : ""
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

    setModel(model) {
        this.model = model
        this.world.replaceChildren()
        this.nodeEls.clear()
        this.edgeEls.clear()
        this.timerEls.clear()
        const box = this.container.getBoundingClientRect()
        const labelWidth = this.labelWidth = (edge) => {
            const context = (this.canvas ??= document.createElement("canvas")).getContext("2d")
            context.font = `10.5px ${getComputedStyle(this.container).getPropertyValue("--mono") || "monospace"}`
            return context.measureText(edgeLabel(edge) + "  ✎⚡").width + 14
        }
        const layout = layoutGraph(model, (node) => this.measure(node), labelWidth, Math.min(2.4, Math.max(0.6, box.width / Math.max(1, box.height))))
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
        for (const node of ordered) {
            this.drawNode(nodeLayer, node, layout.rects.get(node.id))
        }
        for (const edge of model.edges) {
            this.drawEdge(edgeLayer, labelLayer, edge)
        }
        this.userMoved = false
        this.fit()
    }

    drawNode(layer, node, rect) {
        const group = svg("g", { class: `node node-${node.kind}`, "data-id": node.id }, layer)
        if (node.kind === "start") {
            svg("circle", { cx: rect.x + 7, cy: rect.y + 7, r: 6, class: "start-dot" }, group)
        } else if (node.kind === "final") {
            const cx = rect.x + rect.w / 2
            svg("circle", { cx, cy: rect.y + 13, r: 11, class: `final-ring final-${node.outcome}` }, group)
            svg("circle", { cx, cy: rect.y + 13, r: 6, class: `final-core final-${node.outcome}` }, group)
            svg("text", { x: cx, y: rect.y + 37, class: "final-label", "text-anchor": "middle" }, group).textContent = node.outcome
        } else if (node.kind === "compound" || node.kind === "parallel") {
            svg("rect", { x: rect.x, y: rect.y, width: rect.w, height: rect.h, rx: 12, class: "box compound-box" }, group)
            svg("rect", { x: rect.x, y: rect.y, width: rect.w, height: HEADER, rx: 12, class: "compound-head" }, group)
            svg("text", { x: rect.x + 14, y: rect.y + 20, class: "node-name" }, group).textContent = node.id
            if (node.kind === "parallel") {
                const tag = svg("g", { class: "parallel-tag" }, group)
                const label = svg("text", { x: rect.x + rect.w - 14, y: rect.y + 20, "text-anchor": "end", class: "tag-text" }, tag)
                label.textContent = "∥ parallel"
                const regions = node.inside.map((id) => this.layout.rects.get(id))
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
            svg("rect", { x: rect.x, y: rect.y, width: rect.w, height: rect.h, rx: 9, class: "box leaf-box" }, group)
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
            svg("circle", { cx: rect.x + rect.w - 11, cy: rect.y + 11, r: 4, class: "run-dot" }, group)
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
        const from = this.layout.rects.get(edge.from)
        const to = this.layout.rects.get(edge.to)
        if (!from || !to) {
            return
        }
        let d
        let points
        if (edge.from === edge.to) {
            const x = from.x + from.w - 18
            const y = from.y
            d = `M${x},${y} C${x + 10},${y - 34} ${x + 44},${y - 10} ${from.x + from.w},${y + 14}`
        } else {
            let bends = this.layout.routes.get(edge.id) ?? []
            const twins = this.model.edges.filter((other) => (other.from === edge.from && other.to === edge.to) || (other.from === edge.to && other.to === edge.from))
            if (twins.length > 1 && bends.length === 0) {
                const a = { x: from.x + from.w / 2, y: from.y + from.h / 2 }
                const b = { x: to.x + to.w / 2, y: to.y + to.h / 2 }
                const length = Math.hypot(b.x - a.x, b.y - a.y) || 1
                const k = twins.indexOf(edge) - (twins.length - 1) / 2
                const sign = edge.from < edge.to ? 1 : -1
                // Spread twins so their labels sit side by side: by label width across a vertical edge, by label height along a horizontal one.
                const across = Math.abs(b.y - a.y) > Math.abs(b.x - a.x)
                const step = across ? Math.max(...twins.map((t) => this.labelWidth(t))) + 8 : 26
                const offset = k * step * sign
                bends = [{ x: (a.x + b.x) / 2 - ((b.y - a.y) / length) * offset, y: (a.y + b.y) / 2 + ((b.x - a.x) / length) * offset }]
            }
            const toCentre = { x: to.x + to.w / 2, y: to.y + to.h / 2 }
            const fromCentre = { x: from.x + from.w / 2, y: from.y + from.h / 2 }
            const start = boundaryPoint(from, bends[0] ?? toCentre, 1)
            const end = boundaryPoint(to, bends.at(-1) ?? fromCentre, 3)
            points = [start, ...bends, end]
            d = smoothPath(points)
        }
        const immediate = edge.transition?.mode === "immediate"
        const cls = ["edge", `edge-${edge.kind}`, immediate ? "edge-immediate" : ""].join(" ")
        const group = svg("g", { class: cls, "data-id": edge.id }, edgeLayer)
        const marker = edge.kind === "requires" || edge.kind === "ensures" ? "arrow-fallback" : "arrow"
        const path = svg("path", { d, class: "edge-line", "marker-end": `url(#orch-${marker})` }, group)
        const hit = svg("path", { d, class: "edge-hit" }, group)
        const label = edgeLabel(edge)
        let labelGroup = null
        if (label) {
            const length = path.getTotalLength()
            const mid = path.getPointAtLength(length / 2)
            labelGroup = svg("g", { class: `edge-label edge-label-${edge.kind}${immediate ? " edge-label-immediate" : ""}`, "data-id": edge.id }, labelLayer)
            const background = svg("rect", { rx: 9, class: "edge-label-bg" }, labelGroup)
            const text = svg("text", { x: mid.x, y: mid.y + 4, "text-anchor": "middle" }, labelGroup)
            text.textContent = (immediate ? "⚡ " : "") + label + (Object.keys(edge.transition?.set ?? {}).length ? " ✎" : "")
            const w = text.getComputedTextLength() || text.textContent.length * 6.4
            for (const [key, value] of Object.entries({ x: mid.x - w / 2 - 7, y: mid.y - 9, width: w + 14, height: 18 })) {
                background.setAttribute(key, value)
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

    /**
     * Light the nodes active at a step; when `fired` is given, play those edges and flash the nodes entered.
     * @param {import("./history.js").Step} step
     * @param {{ fired?: string[], entered?: string[] }} [animate]
     */
    show(step, animate = {}) {
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
            if (node.kind === "start") {
                lit = active.has(node.parent)
            }
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
        const dot = svg("circle", { r: 5, class: "spark" }, edge.group)
        const length = edge.path.getTotalLength()
        const started = performance.now()
        const duration = 650
        const step = (now) => {
            const t = Math.min(1, (now - started) / duration)
            const eased = 1 - (1 - t) ** 3
            const point = edge.path.getPointAtLength(length * eased)
            dot.setAttribute("cx", point.x)
            dot.setAttribute("cy", point.y)
            if (t < 1) {
                requestAnimationFrame(step)
            } else {
                dot.remove()
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
        const margin = 24
        const k = Math.min(2, (box.width - margin * 2) / (this.layout.width + 60), (box.height - margin * 2) / (this.layout.height + 40))
        this.view = {
            k,
            x: (box.width - this.layout.width * k) / 2,
            y: Math.max(margin, (box.height - this.layout.height * k) / 2) + 10 * k,
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
