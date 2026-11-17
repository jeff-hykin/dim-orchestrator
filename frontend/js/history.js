// Every engine step seen this session, kept in the page, with the blackboard rebuilt at each one, so any moment can
// be shown again.

/**
 * @typedef {object} Step
 * @property {number} seq
 * @property {number} time wall clock seconds
 * @property {any} item what the engine handled
 * @property {any[]} effects
 * @property {Record<string, any>} changed
 * @property {string[]} removed
 * @property {string[]} active
 * @property {any[]} calls
 * @property {any[]} timers
 * @property {[string, string][]} outcomes
 * @property {Record<string, any>} blackboard the whole blackboard after the step
 * @property {Record<string, number>} changedAt for each key, the seq of the step that last changed it
 */

export class History {
    constructor() {
        /** @type {Step[]} */
        this.steps = []
        this.faulted = false
    }

    get last() {
        return this.steps.at(-1)
    }

    get seq() {
        return this.last?.seq ?? 0
    }

    /** Start from a snapshot, when the steps before it are no longer in the journal. */
    seed(snapshot) {
        this.steps = [
            {
                seq: snapshot.seq,
                time: snapshot.time ?? Date.now() / 1000,
                item: { kind: "joined" },
                effects: [],
                changed: {},
                removed: [],
                active: snapshot.active ?? [],
                calls: snapshot.calls ?? [],
                timers: snapshot.timers ?? [],
                outcomes: snapshot.outcomes ?? [],
                blackboard: { ...(snapshot.blackboard ?? {}) },
                changedAt: {},
            },
        ]
        this.faulted = !!snapshot.faulted
    }

    /** Add journal entries in order. Returns the steps added. */
    add(entries) {
        const added = []
        for (const entry of entries) {
            if (entry.seq <= this.seq) {
                continue
            }
            const before = this.last
            const blackboard = { ...(before?.blackboard ?? {}), ...entry.changed }
            const changedAt = { ...(before?.changedAt ?? {}) }
            for (const key of Object.keys(entry.changed)) {
                changedAt[key] = entry.seq
            }
            for (const key of entry.removed) {
                delete blackboard[key]
                changedAt[key] = entry.seq
            }
            const step = { ...entry, blackboard, changedAt }
            this.steps.push(step)
            added.push(step)
            if (entry.effects.some((effect) => effect.kind === "fault")) {
                this.faulted = true
            }
        }
        return added
    }

    /** The index of the last step at or before a wall-clock time. */
    indexAt(time) {
        let lo = 0
        let hi = this.steps.length - 1
        if (hi < 0 || time < this.steps[0].time) {
            return 0
        }
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1
            if (this.steps[mid].time <= time) {
                lo = mid
            } else {
                hi = mid - 1
            }
        }
        return lo
    }
}
