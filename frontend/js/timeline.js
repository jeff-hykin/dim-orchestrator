// A thin timeline along the bottom: the last 10 minutes, scrolling left as time passes (wheel or swipe sideways to
// look further back), a tick for every transition, a cursor to drag back through the session, play to replay from
// there, and Live to follow the orchestrator again.

import { h } from "./details.js"

/** Seconds the track shows at once. */
const WINDOW_S = 600

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
        this.windowEnd = null // null: the window ends now and follows live time
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
            if (fraction >= 0.995 && this.windowEnd == null) {
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
        this.track.addEventListener("wheel", (event) => {
            event.preventDefault()
            const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
            this.scrollTo((this.windowEnd ?? this.now()) + (delta / this.track.clientWidth) * WINDOW_S)
        }, { passive: false })
        new ResizeObserver(() => this.draw()).observe(this.track)
    }

    /** The newest time there is: live time, or the last step's. */
    now() {
        const steps = this.history.steps
        return Math.max(steps.at(-1)?.time ?? 0, this.liveTime ?? 0)
    }

    /** The first step's time, where the session began. */
    began() {
        return this.history.steps[0]?.time ?? this.now()
    }

    /** Move the window to end at `end`, clamped to the session; at now it follows live time again. */
    scrollTo(end) {
        const now = this.now()
        const clamped = Math.max(Math.min(now, this.began() + WINDOW_S), Math.min(now, end))
        this.windowEnd = clamped >= now ? null : clamped
        this.draw()
    }

    /** The times the track shows: the last WINDOW_S seconds up to the window's end. */
    range() {
        const end = this.windowEnd ?? this.now()
        return [end - WINDOW_S, end]
    }

    /** Scroll so a rewound cursor stays on the track. */
    keepInView(time) {
        const [start, end] = this.range()
        if (time < start || time > end) {
            this.scrollTo(time + WINDOW_S * 0.2)
        }
    }

    seek(index, animate) {
        this.index = index
        if (this.history.steps[index]) {
            this.keepInView(this.history.steps[index].time)
        }
        this.live.classList.toggle("on", false)
        this.handlers.onSeek(index, animate)
        this.draw()
    }

    goLive() {
        this.stopPlay()
        this.index = null
        this.windowEnd = null
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
            this.keepInView(clock)
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

    /** Redraw: minute marks, ticks for transitions (faults and edits stand out), and the cursor. */
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
        const began = this.began()
        context.fillStyle = color("--border")
        context.fillRect(Math.max(0, x(began)), box.height / 2 - 1, box.width, 2)
        // a faint mark each minute of the session, labeled with its clock, so the track visibly scrolls
        context.font = `9px ${style.fontFamily}`
        context.textBaseline = "top"
        for (let minute = Math.max(0, Math.ceil((start - began) / 60)); began + minute * 60 <= end; minute++) {
            const at = Math.round(x(began + minute * 60)) + 0.5
            context.fillStyle = color("--border")
            context.fillRect(at, 0, 1, box.height)
            context.fillStyle = color("--muted-fg")
            context.fillText(`${minute}:00`, at + 3, 1)
        }
        const steps = this.history.steps
        for (let i = this.history.indexAt(start); i < steps.length && steps[i].time <= end; i++) {
            const step = steps[i]
            if (step.time < start) {
                continue
            }
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
        const now = this.now()
        const at = this.index == null ? now : this.playClock ?? steps[this.index]?.time ?? now
        const cursorX = x(at)
        this.cursor.style.left = `${Math.min(box.width, Math.max(0, cursorX))}px`
        this.cursor.hidden = cursorX < 0 || cursorX > box.width
        this.cursor.classList.toggle("live", this.index == null)
        const seconds = Math.max(0, at - began)
        const behind = this.index == null ? "" : ` · −${(now - at).toFixed(1)}s`
        this.label.textContent = steps.length ? `${formatClock(seconds)}${behind}` : ""
    }
}

function formatClock(seconds) {
    const m = Math.floor(seconds / 60)
    const s = Math.floor(seconds % 60)
    return `${m}:${String(s).padStart(2, "0")}`
}
