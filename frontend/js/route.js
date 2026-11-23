// Edge routing around nodes: each edge runs in straight horizontal and vertical stretches through the gaps between the
// boxes it is not part of (it may cross other edges, never a node), with as few turns and as little length as it can.

// how far a route keeps from a box it passes
const MARGIN = 7
// what one turn costs, in pixels of length
const TURN = 36
// what each pixel along a stretch another route already runs on costs, on top of its length
const SHARED = 1.5

const DIRS = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }]

/**
 * @typedef {{ x: number, y: number, w: number, h: number }} Rect
 * @typedef {{ x: number, y: number, dir: number, cost: number }} Goal a point the route may end at, the way it must be
 *   heading there (an index into DIRS), and what ending there costs
 */

/** Sorted, de-duplicated coordinates, with the middle of each gap between neighbours added (the channel centres). */
function axis(values, low, high) {
    const sorted = [...new Set(values.filter((v) => v >= low && v <= high).map((v) => Math.round(v * 2) / 2))].sort((a, b) => a - b)
    const out = []
    for (let i = 0; i < sorted.length; i++) {
        if (i && sorted[i] - sorted[i - 1] > 2 * MARGIN) {
            out.push((sorted[i] + sorted[i - 1]) / 2)
        }
        out.push(sorted[i])
    }
    return out
}

/** A tiny binary heap of [cost, value]. */
class Heap {
    constructor() {
        this.items = []
    }
    push(cost, value) {
        const items = this.items
        items.push([cost, value])
        let i = items.length - 1
        while (i > 0) {
            const parent = (i - 1) >> 1
            if (items[parent][0] <= items[i][0]) {
                break
            }
            ;[items[parent], items[i]] = [items[i], items[parent]]
            i = parent
        }
    }
    pop() {
        const items = this.items
        const top = items[0]
        const last = items.pop()
        if (items.length) {
            items[0] = last
            let i = 0
            for (;;) {
                const a = 2 * i + 1
                const b = a + 1
                let least = i
                if (a < items.length && items[a][0] < items[least][0]) {
                    least = a
                }
                if (b < items.length && items[b][0] < items[least][0]) {
                    least = b
                }
                if (least === i) {
                    break
                }
                ;[items[least], items[i]] = [items[i], items[least]]
                i = least
            }
        }
        return top
    }
    get size() {
        return this.items.length
    }
}

/**
 * The cheapest route from `start` (heading `startDir`) to one of `goals`, through `region`, around `obstacles`.
 * @param {{ x: number, y: number }} start
 * @param {number} startDir
 * @param {Goal[]} goals
 * @param {Rect[]} obstacles
 * @param {Rect} region
 * @param {{ h: Map<number, number[][]>, v: Map<number, number[][]> }} used the stretches earlier routes run along
 *   (horizontal ones by their y, vertical ones by their x), which this one adds its own to
 * @returns {{ x: number, y: number }[] | null} the corners, from start to the goal reached
 */
export function route(start, startDir, goals, obstacles, region, used) {
    const grown = obstacles.map((o) => ({ x0: o.x - MARGIN, y0: o.y - MARGIN, x1: o.x + o.w + MARGIN, y1: o.y + o.h + MARGIN }))
    const inside = (x, y) => grown.some((o) => x > o.x0 + 0.01 && x < o.x1 - 0.01 && y > o.y0 + 0.01 && y < o.y1 - 0.01)
    const x0 = region.x
    const y0 = region.y
    const x1 = region.x + region.w
    const y1 = region.y + region.h
    const xs = axis([x0, x1, start.x, ...goals.map((g) => g.x), ...grown.flatMap((o) => [o.x0, o.x1])], x0, x1)
    const ys = axis([y0, y1, start.y, ...goals.map((g) => g.y), ...grown.flatMap((o) => [o.y0, o.y1])], y0, y1)
    const xi = new Map(xs.map((v, i) => [v, i]))
    const yi = new Map(ys.map((v, i) => [v, i]))
    const snap = (v) => Math.round(v * 2) / 2
    const si = xi.get(snap(start.x))
    const sj = yi.get(snap(start.y))
    if (si == null || sj == null) {
        return null
    }
    const goalAt = new Map()
    for (const goal of goals) {
        const gi = xi.get(snap(goal.x))
        const gj = yi.get(snap(goal.y))
        if (gi != null && gj != null && !inside(xs[gi], ys[gj])) {
            goalAt.set(`${gi},${gj}`, [...(goalAt.get(`${gi},${gj}`) ?? []), goal])
        }
    }
    if (!goalAt.size) {
        return null
    }
    const W = xs.length
    const key = (i, j, d) => (j * W + i) * 4 + d
    const best = new Map()
    const from = new Map()
    const heap = new Heap()
    const guess = (i, j) => Math.min(...goals.map((g) => Math.abs(xs[i] - g.x) + Math.abs(ys[j] - g.y)))
    const startKey = key(si, sj, startDir)
    best.set(startKey, 0)
    heap.push(guess(si, sj), { i: si, j: sj, d: startDir, cost: 0, at: startKey })
    let found = null
    while (heap.size) {
        const [, { i, j, d, cost, at, done }] = heap.pop()
        if (done) {
            found = at
            break
        }
        if (cost > (best.get(at) ?? Infinity)) {
            continue
        }
        for (const goal of goalAt.get(`${i},${j}`) ?? []) {
            const total = cost + goal.cost + (goal.dir === d ? 0 : (goal.dir + 2) % 4 === d ? 2 * TURN : TURN)
            heap.push(total, { done: true, at })
        }
        for (let nd = 0; nd < 4; nd++) {
            if ((nd + 2) % 4 === d) {
                continue
            }
            const ni = i + DIRS[nd].x
            const nj = j + DIRS[nd].y
            if (ni < 0 || nj < 0 || ni >= W || nj >= ys.length) {
                continue
            }
            if (inside(xs[ni], ys[nj]) || inside((xs[i] + xs[ni]) / 2, (ys[j] + ys[nj]) / 2)) {
                continue
            }
            const length = Math.abs(xs[ni] - xs[i]) + Math.abs(ys[nj] - ys[j])
            const shared = nd % 2 ? overlap(used.v.get(xs[i]), ys[j], ys[nj]) : overlap(used.h.get(ys[j]), xs[i], xs[ni])
            const next = cost + length + SHARED * shared + (nd === d ? 0 : TURN)
            const nextKey = key(ni, nj, nd)
            if (next < (best.get(nextKey) ?? Infinity)) {
                best.set(nextKey, next)
                from.set(nextKey, at)
                heap.push(next + guess(ni, nj), { i: ni, j: nj, d: nd, cost: next, at: nextKey })
            }
        }
    }
    if (found == null) {
        return null
    }
    // walk back to the start, collecting grid points
    const cells = []
    let at = found
    while (at != null) {
        const cell = Math.floor(at / 4)
        cells.push([cell % W, Math.floor(cell / W)])
        at = from.get(at)
    }
    cells.reverse()
    const points = cells.map(([i, j]) => ({ x: xs[i], y: ys[j] }))
    const corners = simplify(points)
    for (let n = 1; n < corners.length; n++) {
        const [a, b] = [corners[n - 1], corners[n]]
        const [lines, at, span] = a.y === b.y ? [used.h, a.y, [a.x, b.x]] : [used.v, a.x, [a.y, b.y]]
        lines.set(at, [...(lines.get(at) ?? []), span.sort((m, k) => m - k)])
    }
    return corners
}

/** How much of the stretch from `a` to `b` the spans already cover. */
function overlap(spans, a, b) {
    const [low, high] = a < b ? [a, b] : [b, a]
    let total = 0
    for (const [m, k] of spans ?? []) {
        total += Math.max(0, Math.min(high, k) - Math.max(low, m))
    }
    return total
}

/** Drop repeated and straight-through points, keeping only the corners. */
export function simplify(points) {
    const out = []
    for (const point of points) {
        const last = out.at(-1)
        if (last && Math.abs(last.x - point.x) < 0.01 && Math.abs(last.y - point.y) < 0.01) {
            continue
        }
        const before = out.at(-2)
        if (before && last && ((Math.abs(before.x - last.x) < 0.01 && Math.abs(last.x - point.x) < 0.01) || (Math.abs(before.y - last.y) < 0.01 && Math.abs(last.y - point.y) < 0.01))) {
            out[out.length - 1] = point
            continue
        }
        out.push(point)
    }
    return out
}
