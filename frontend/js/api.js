// The running orchestrator: found through the dimos gateway, followed through Desktop's zenoh-gateway. The app only
// reads: it asks for the state on orchestrator_state_request and draws each message on orchestrator_state.

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

/** The running modules that are orchestrators. */
export function orchestratorsIn(modules) {
    return modules.filter((module) => module.class === "Orchestrator")
}

const STATE_KEY = "dimos/orchestrator_state/std_msgs.String" // dimos-yaml-check: ignore
const REQUEST_KEY = "dimos/orchestrator_state_request/std_msgs.Bool" // dimos-yaml-check: ignore
// std_msgs.Bool(True) as LCM: its 8-byte fingerprint, then the bool
const TRUE_BOOL = Uint8Array.of(0x1e, 0xbe, 0xf0, 0x6a, 0x50, 0x95, 0x0e, 0x3e, 1)

/** A std_msgs.String's text from its LCM bytes: an 8-byte hash, a big-endian int32 length (counting a closing NUL),
 * then UTF-8. Read here rather than with the gateway's msgs.js, which a gateway may take minutes to build. */
function lcmString(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const length = view.getInt32(8)
    return new TextDecoder().decode(bytes.subarray(12, 12 + Math.max(0, length - 1)))
}

async function zenoh() {
    const { getZenoh } = await import("../vendor/dim-app/zenoh.js")
    return getZenoh()
}

/** `callback(state)` with each orchestrator_state message, parsed (every step, in order). Returns the unsubscribe. */
export async function watchState(callback) {
    return (await zenoh()).subscribe(STATE_KEY, { delivery: "reliable" }, (message) => {
        callback(JSON.parse(lcmString(message.bytes)))
    })
}

/** Ask the orchestrator to publish its state now, rather than at its next step. */
export async function requestState() {
    const client = await zenoh()
    await client.ready
    await client.client.put(REQUEST_KEY, TRUE_BOOL)
}
