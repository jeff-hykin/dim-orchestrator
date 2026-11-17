// A thin timeline along the bottom: a tick for every transition, a cursor to drag back through the session, play to
// replay from there, and Live to follow the orchestrator again.

import { h } from "./details.js"

export class Timeline {
    /**
     * @param {HTMLElement} container
     * @param {import("./history.js").History} history
     * @param {{ onSeek: (index: number | null, animate: boolean) => void }} handlers index null = live
     */
    constructor(container, history, handlers) {
        this.history = history
        this.handlers = handlers
        this.index = null
        this.playing = false
        this.play = h("button", { class: "tl-play", type: "button", title: "replay from here", onclick: () => this.togglePlay() }, "▶")
        this.live = h("button", { class: "tl-live on", type: "button", title: "follow the orchestrator", onclick: () => this.goLive() }, "● Live")
        this.canvas = h("canvas", { class: "tl-canvas" })
        this.track = h("div", { class: "tl-track", tabindex: "0", role: "slider", "aria-label": "rewind" }, this.canvas, h("div", { class: "tl-cursor" }))
        this.label = h("span", { class: "tl-label" })
        container.append(this.play, this.track, this.label, this.live)
        this.cursor = this.track.querySelector(".tl-cursor")
        let dragging = false
        const seekTo = (event) => {
            const box = this.track.getBoundingClientRect()
            const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width))
            const [start, end] = this.range()
            const index = this.history.indexAt(start + fraction * (end - start))
            if (fraction >= 0.995) {
                this.goLive()
            } else {
                this.seek(index, false)
            }
        }
        this.track.addEventListener("pointerdown", (event) => {
            dragging = true
            this.track.setPointerCapture(event.pointerId)
            this.stopPlay()
            seekTo(event)
        })
        this.track.addEventListener("pointermove", (event) => dragging && seekTo(event))
        this.track.addEventListener("pointerup", () => (dragging = false))
        this.track.addEventListener("keydown", (event) => {
            const at = this.index ?? this.history.steps.length - 1
            if (event.key === "ArrowLeft") {
                this.seek(Math.max(0, at - 1), true)
            } else if (event.key === "ArrowRight") {
                at + 1 >= this.history.steps.length - 1 ? this.goLive() : this.seek(at + 1, true)
            }
        })
        new ResizeObserver(() => this.draw()).observe(this.track)
    }

    range() {
        const steps = this.history.steps
        if (!steps.length) {
            return [0, 1]
        }
        const start = steps[0].time
        const end = Math.max(steps.at(-1).time, this.liveTime ?? 0, start + 1)
        return [start, end]
    }

    seek(index, animate) {
        this.index = index
        this.live.classList.toggle("on", false)
        this.handlers.onSeek(index, animate)
        this.draw()
    }

    goLive() {
        this.stopPlay()
        this.index = null
        this.live.classList.add("on")
        this.handlers.onSeek(null, false)
        this.draw()
    }

    togglePlay() {
        if (this.playing) {
            this.stopPlay()
            return
        }
        if (this.index == null) {
            return
        }
        this.playing = true
        this.play.textContent = "❚❚"
        let clock = this.history.steps[this.index].time
        let last = performance.now()
        const tick = (now) => {
            if (!this.playing) {
                return
            }
            clock += (now - last) / 1000
            last = now
            const steps = this.history.steps
            while (this.index + 1 < steps.length && steps[this.index + 1].time <= clock) {
                this.index++
                this.handlers.onSeek(this.index, true)
            }
            if (this.index + 1 >= steps.length) {
                this.goLive()
                return
            }
            this.playClock = clock
            this.draw()
            requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
    }

    stopPlay() {
        this.playing = false
        this.playClock = null
        this.play.textContent = "▶"
    }

    /** Redraw: ticks for transitions (faults and edits stand out), and the cursor. */
    draw(liveTime) {
        if (liveTime != null) {
            this.liveTime = liveTime
        }
        const box = this.track.getBoundingClientRect()
        const ratio = devicePixelRatio || 1
        this.canvas.width = Math.max(1, Math.round(box.width * ratio))
        this.canvas.height = Math.max(1, Math.round(box.height * ratio))
        const context = this.canvas.getContext("2d")
        context.scale(ratio, ratio)
        const style = getComputedStyle(this.track)
        const color = (name) => style.getPropertyValue(name).trim() || style.color
        const [start, end] = this.range()
        const x = (time) => ((time - start) / (end - start)) * box.width
        context.fillStyle = color("--border")
        context.fillRect(0, box.height / 2 - 1, box.width, 2)
        for (const step of this.history.steps) {
            const kinds = new Set(step.effects.map((effect) => effect.kind))
            const fault = kinds.has("fault")
            const edit = step.item.kind === "edit"
            if (!fault && !edit && !kinds.has("transition")) {
                continue
            }
            context.fillStyle = color(fault ? "--danger" : edit ? "--warn" : "--primary")
            const height = fault || edit ? box.height - 4 : box.height * 0.6
            context.fillRect(Math.round(x(step.time)) - 0.5, (box.height - height) / 2, fault ? 3 : 1.5, height)
        }
        const steps = this.history.steps
        const at = this.index == null ? end : this.playClock ?? steps[this.index]?.time ?? end
        this.cursor.style.left = `${Math.min(box.width, x(at))}px`
        this.cursor.classList.toggle("live", this.index == null)
        const seconds = Math.max(0, at - start)
        const behind = this.index == null ? "" : ` · −${(end - at).toFixed(1)}s`
        this.label.textContent = steps.length ? `${formatClock(seconds)}${behind}` : ""
    }
}

function formatClock(seconds) {
    const m = Math.floor(seconds / 60)
    const s = Math.floor(seconds % 60)
    return `${m}:${String(s).padStart(2, "0")}`
}
