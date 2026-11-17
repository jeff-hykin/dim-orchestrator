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
    return modules.filter((module) => {
        const names = new Set((module.rpcs ?? []).map((rpc) => rpc.name))
        return module.class === "Orchestrator" || (names.has("journal") && names.has("definition") && names.has("state"))
    })
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
