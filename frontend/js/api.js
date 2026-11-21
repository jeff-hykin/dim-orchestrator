// The running orchestrator, through the dimos gateway: find its module, read its definition and journal, set values.

const GATEWAY = "../../gateways/dimos/"

async function json(path, init) {
    const response = await fetch(new URL(path, new URL(GATEWAY, location.href)), init)
    const body = await response.json().catch(() => null)
    if (!response.ok) {
        const error = new Error(body?.error ?? body?.detail ?? `${response.status} ${response.statusText}`)
        error.status = response.status
        throw error
    }
    return body
}

/** Every running module, or [] when nothing runs. Throws when the gateway itself is unreachable. */
export async function runningModules() {
    try {
        return (await json("active/modules")).modules ?? []
    } catch (error) {
        // the gateway answers 404/409/503 while no blueprint runs
        if (error.status && error.status < 500 && error.status !== 403) {
            return []
        }
        throw error
    }
}

/** The running modules that are orchestrators: an Orchestrator class, or anything with its RPCs. */
export function orchestratorsIn(modules) {
    return modules.filter((module) => module.class === "Orchestrator" || hasJournal(module))
}

/** Whether a module has the journal RPCs; without them the app follows its orchestrator_state stream instead. */
export function hasJournal(module) {
    const names = new Set((module?.rpcs ?? []).map((rpc) => rpc.name))
    return names.has("journal") && names.has("definition") && names.has("state")
}

/** Call one RPC of a running module. */
export async function call(moduleId, name, kwargs = {}) {
    const body = await json(`active/modules/${encodeURIComponent(moduleId)}/rpcs/${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ args: [], kwargs }),
    })
    if (!body.ok) {
        throw new Error(body.error ?? `${name} failed`)
    }
    return body.result
}

export const getDefinition = (moduleId) => call(moduleId, "definition")
export const getState = (moduleId) => call(moduleId, "state")
export const getJournal = (moduleId, after, limit = 1000) => call(moduleId, "journal", { after, limit })
export const setValue = (moduleId, key, value) => call(moduleId, "set_value", { key, value })
/** Replace the orchestrator's file: the problems found (nothing changed), or [] once it runs the new file. */
export const setSource = (moduleId, source) => call(moduleId, "set_source", { source })

const STATE_KEY = "dimos/orchestrator_state/std_msgs.String" // dimos-yaml-check: ignore

/** A std_msgs.String's text from its LCM bytes: an 8-byte hash, a big-endian int32 length (counting a closing NUL),
 * then UTF-8. Read here rather than with the gateway's msgs.js, which a gateway may take minutes to build. */
function lcmString(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const length = view.getInt32(8)
    return new TextDecoder().decode(bytes.subarray(12, 12 + Math.max(0, length - 1)))
}

/** `callback(state)` with each orchestrator_state message, parsed, straight from Desktop's zenoh-gateway (every step,
 * in order). Returns the unsubscribe. */
export async function watchState(callback) {
    const { getZenoh } = await import("../vendor/dim-app/zenoh.js")
    return getZenoh().subscribe(STATE_KEY, { delivery: "reliable" }, (message) => {
        callback(JSON.parse(lcmString(message.bytes)))
    })
}
