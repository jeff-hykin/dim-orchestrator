#!/usr/bin/env -S deno run -A
// Record the demo videos: for each demo, `dimos run orchestration-demo-<name>` in a dimos checkout, a dimos gateway
// on its own socket, this app served by tools/dev.js, and a scripted browser session, saved as videos/<name>.mp4.
//
//     deno run -A tools/record_demos.js --dimos ~/repos/dimos            # all of them
//     deno run -A tools/record_demos.js --dimos ~/repos/dimos patrol jam # some
//
// The dimos checkout needs the orchestrator's state RPCs and demos (branch jeff/feat/orchestrator-state) and a .venv.

import { Command } from "jsr:@cliffy/command@1.0.0-rc.7"
import { $ } from "https://esm.sh/dax-sh@0.42.0"
import { chromium, devices } from "npm:playwright@1.60.0"
import { startDevServer } from "./dev.js"

const here = new URL(".", import.meta.url).pathname
const repo = `${here}..`

// What each video shows, step by step. `ui` is the page driver below.
const DEMOS = {
    patrol: {
        about: "nested nodes, events, an outer transition interrupting the inside, `after` timers, rewind",
        async run(ui) {
            await ui.caption("Patrol: the active nodes are lit; each transition plays along its edge")
            await ui.pause(3)
            await ui.caption("Hover a node: its activity, args, result and transitions")
            await ui.hoverNode("Driving", 3)
            await ui.caption("Hover a pill: its live value and what sets it")
            await ui.hoverPillInPanel("battery_level", 2.5)
            await ui.caption("Hover an edge: an outer transition on the battery_low event")
            await ui.hoverEdge("Patrolling#0", 3.5)
            await ui.caption("Battery low: Patrolling is interrupted, whatever was active inside it")
            await ui.waitActive("Charging", 40)
            await ui.pause(2)
            await ui.hoverNode("OnCharger", 3)
            await ui.waitActive("Patrolling", 40)
            await ui.pause(2)
            await ui.caption("Rewind: drag the timeline back, then replay")
            await ui.rewind(0.55)
            await ui.pause(1.5)
            await ui.play(5)
            await ui.caption("Live: back to following the orchestrator")
            await ui.live()
            await ui.pause(2)
        },
    },
    delivery: {
        about: "retries with a counter, `done`/`failed` outcomes of nested nodes, approving by editing a var",
        async run(ui) {
            await ui.caption("Delivery: picking fails twice; the retry edge counts attempts")
            await ui.pause(2)
            await ui.hoverEdge("Picking#1", 3.5)
            await ui.caption("Picked: Fetch is done, so its `done` transition fires")
            await ui.waitActive("AwaitApproval", 40)
            await ui.hoverNode("AwaitApproval", 3)
            await ui.hoverPillInPanel("attempts", 2)
            await ui.caption("Approve from the blackboard: set the var `approved` to true")
            await ui.editValue("approved", "true")
            await ui.caption("Deliver runs to its own `done`")
            await ui.waitActive("Delivered", 30)
            await ui.hoverNode("Deliver", 3)
            await ui.pause(2)
        },
    },
    inspection: {
        about: "`requires` and `ensures` checks sending the robot to their fallbacks",
        async run(ui) {
            await ui.caption("Inspection: Scanning has a `requires` and an `ensures` check")
            await ui.caption("The gripper isn't ok, so `requires` sends it to its fallback, Calibrating")
            await ui.waitActive("Calibrating", 30)
            await ui.hoverEdge("Scanning!requires0", 3)
            await ui.caption("Too few objects found: `ensures` fails on the way out, so Rescan instead")
            await ui.waitActive("Rescan", 30)
            await ui.hoverNode("Scanning", 4)
            await ui.hoverEdge("Scanning!ensures0", 3)
            await ui.hoverPillInPanel("found", 2.5)
            await ui.caption("Enough found: the transition goes through")
            await ui.waitActive("Reporting", 40)
            await ui.pause(3)
        },
    },
    shift: {
        about: "a parallel node: three regions running at once, and a quota that ends them together",
        async run(ui) {
            await ui.caption("Shift: a parallel node; courier, sorter and watchdog all run at once")
            await ui.pause(2)
            await ui.hoverNode("Shift", 3)
            await ui.hoverNode("Sorter", 2.5)
            await ui.caption("The blackboard can be hidden for more room")
            await ui.togglePanel()
            await ui.pause(4)
            await ui.togglePanel()
            await ui.caption("When the quota is met, the whole parallel node is left together")
            await ui.hoverEdge("Shift#0", 3)
            await ui.waitActive("Closing", 60)
            await ui.pause(4)
        },
    },
    safety: {
        about: "graceful vs immediate transitions: an obstacle stows the crate first (`ensures`), an e-stop does not",
        async run(ui) {
            await ui.caption("Safety: an obstacle leaves Working gracefully; an e-stop leaves it immediately")
            await ui.pause(2)
            await ui.hoverEdge("Working#1", 3)
            await ui.hoverEdge("Working#0", 3)
            await ui.caption("Obstacle while carrying: Working's `ensures` (not carrying) fails, so it stows the crate first")
            await ui.waitActive("Stowing", 30)
            await ui.pause(1)
            await ui.hoverNode("Working", 3)
            await ui.caption("E-stop: the immediate transition skips every check")
            await ui.waitActive("EStopped", 30)
            await ui.pause(2)
            await ui.waitActive("Working", 20)
            await ui.pause(2)
            await ui.caption("Inject a signal from the blackboard: obstacle = true, then false")
            await ui.editValue("obstacle", "true")
            await ui.pause(4)
            await ui.editValue("obstacle", "false")
            await ui.pause(3)
        },
    },
    jam: {
        about: "on a phone: a held start waiting for a cancel, and the fault when the cancel never returns",
        phone: true,
        async run(ui) {
            await ui.caption("Jam, on a phone: tap a node for its details")
            await ui.pause(2)
            await ui.tapNode("Placing", 3)
            await ui.tapAway()
            await ui.caption("The blackboard slides up as a sheet; a held start waits for the arm's cancel")
            await ui.togglePanel()
            await ui.pause(3)
            await ui.caption("The arm's cancel never returns: the orchestrator faults and stops")
            await ui.waitFault(40)
            await ui.pause(2)
            await ui.togglePanel()
            await ui.tapNode("Picking", 3)
            await ui.tapAway()
            await ui.caption("Rewind on the timeline to see the steps before the fault")
            await ui.rewind(0.35)
            await ui.pause(2)
            await ui.live()
            await ui.pause(2)
        },
    },
}

/** A page driver that moves a visible cursor, so the video shows what is being pointed at. */
function driver(page, phone) {
    const centre = async (locator) => {
        const box = await locator.boundingBox()
        if (!box) {
            throw new Error(`not on screen: ${locator}`)
        }
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }
    const moveTo = async (point) => {
        await page.mouse.move(point.x, point.y, { steps: 18 })
    }
    const ui = {
        pause: (seconds) => page.waitForTimeout(seconds * 1000),
        /** A caption along the top of the video saying what to look at. */
        caption: (text) =>
            page.evaluate((text) => {
                let element = document.getElementById("record-caption")
                if (!element) {
                    element = document.createElement("div")
                    element.id = "record-caption"
                    element.style.cssText = "position:fixed;z-index:98;left:50%;bottom:56px;transform:translateX(-50%);max-width:92vw;" +
                        "padding:6px 14px;border-radius:999px;background:rgba(10,10,20,.82);color:#fff;font:600 13px system-ui;" +
                        "border:1px solid rgba(255,255,255,.25);pointer-events:none;text-align:center"
                    document.body.append(element)
                }
                element.textContent = text
            }, text),
        async hoverNode(id, seconds) {
            await moveTo(await centre(page.locator(`g.node[data-id="${id}"] > rect, g.node[data-id="${id}"] > circle`).first()))
            await ui.pause(seconds)
        },
        async hoverEdge(id, seconds) {
            await moveTo(await centre(page.locator(`g.edge-label[data-id="${id}"]`)))
            await ui.pause(seconds)
        },
        async hoverPillInPanel(key, seconds) {
            await moveTo(await centre(page.locator(`#blackboard-body .bb-row[data-key="${key}"] .pill`)))
            await ui.pause(seconds)
        },
        async tapNode(id, seconds) {
            const point = await centre(page.locator(`g.node[data-id="${id}"] > rect`).first())
            await moveTo(point)
            await page.touchscreen.tap(point.x, point.y)
            await ui.pause(seconds)
        },
        async tapAway() {
            await page.locator("#tooltip-close").click()
            await ui.pause(0.5)
        },
        async togglePanel() {
            const button = page.locator("#toggle-panel")
            await moveTo(await centre(button))
            await button.click()
            await ui.pause(0.8)
        },
        async editValue(key, text) {
            await ui.hoverPillInPanel(key, 0.6)
            const row = page.locator(`#blackboard-body .bb-row[data-key="${key}"]`)
            await row.locator(".bb-edit").click()
            await page.keyboard.press("ControlOrMeta+a")
            await page.keyboard.type(text, { delay: 90 })
            await ui.pause(0.6)
            await page.keyboard.press("Enter")
            await ui.pause(1)
        },
        async waitActive(id, timeoutSeconds) {
            await page.waitForSelector(`g.node.active[data-id="${id}"]`, { timeout: timeoutSeconds * 1000 })
        },
        async waitFault(timeoutSeconds) {
            await page.waitForSelector("#fault:not([hidden])", { timeout: timeoutSeconds * 1000 })
        },
        async rewind(fraction) {
            const box = await page.locator(".tl-track").boundingBox()
            const y = box.y + box.height / 2
            await moveTo({ x: box.x + box.width - 4, y })
            await page.mouse.down()
            await page.mouse.move(box.x + box.width * fraction, y, { steps: 40 })
            await page.mouse.up()
        },
        async play(seconds) {
            const button = page.locator(".tl-play")
            await moveTo(await centre(button))
            await button.click()
            await ui.pause(seconds)
        },
        async live() {
            const button = page.locator(".tl-live")
            await moveTo(await centre(button))
            await button.click()
        },
    }
    if (phone) {
        ui.hoverNode = ui.tapNode
    }
    return ui
}

// Draws the pointer into the page, since a recording has none.
const CURSOR = `
addEventListener("DOMContentLoaded", () => {
    const dot = document.createElement("div")
    dot.style.cssText = "position:fixed;z-index:99;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;" +
        "background:rgba(255,255,255,.35);border:2px solid #fff;pointer-events:none;left:-40px;top:-40px;transition:transform .1s"
    document.body.append(dot)
    const move = (x, y) => { dot.style.left = x + "px"; dot.style.top = y + "px" }
    addEventListener("pointermove", (e) => move(e.clientX, e.clientY), true)
    addEventListener("pointerdown", (e) => { move(e.clientX, e.clientY); dot.style.transform = "scale(.7)" }, true)
    addEventListener("pointerup", () => (dot.style.transform = ""), true)
})`

await new Command()
    .name("record_demos")
    .description("Record a video of the app against each orchestrator demo")
    .option("-d, --dimos <path:string>", "a dimos checkout with the orchestrator demos and a .venv", { required: true })
    .option("-o, --out <dir:string>", "where the videos go", { default: `${repo}/videos` })
    .option("--port <port:integer>", "the app's port", { default: 8766 })
    .option("--gateway-port <port:integer>", "the gateway's port", { default: 7812 })
    .arguments("[...demos:string]")
    .action(async ({ dimos, out, port, gatewayPort }, ...names) => {
        names = names.length ? names : Object.keys(DEMOS)
        await Deno.mkdir(out, { recursive: true })
        const bin = `${dimos}/.venv/bin`
        const socket = `/tmp/dim-orchestrator-record-${gatewayPort}.sock`
        const gateway = $`${bin}/python -m experimental.gateway --port ${gatewayPort} --no-zenoh --dimos-dir ${dimos}`
            .cwd(dimos).env({ DIMOS_APP: JSON.stringify({ socket }) }).quiet().noThrow().spawn()
        const server = startDevServer({ port, gateway: `http://127.0.0.1:${gatewayPort}`, theme: "http://127.0.0.1:5555/theme.css" })
        const browser = await chromium.launch()
        const failed = []
        try {
            for (const name of names) {
                const demo = DEMOS[name]
                if (!demo) {
                    throw new Error(`no demo ${name} (there are: ${Object.keys(DEMOS).join(", ")})`)
                }
                console.log(`== ${name}: ${demo.about}`)
                await $`${bin}/dimos stop`.cwd(dimos).quiet().noThrow()
                // The page opens first, so the video starts on "no orchestrator running" and catches every step.
                const size = demo.phone ? devices["iPhone 13"].viewport : { width: 1280, height: 760 }
                const context = await browser.newContext({
                    ...(demo.phone ? devices["iPhone 13"] : { viewport: size }),
                    recordVideo: { dir: `${out}/raw`, size },
                })
                await context.addInitScript(CURSOR)
                const page = await context.newPage()
                await page.goto(`http://127.0.0.1:${port}/apps/dim-orchestrator/`)
                await page.waitForSelector("#status[data-status=none]", { timeout: 30000 })
                const run = $`${bin}/dimos --viewer none run orchestration-demo-${name}`.cwd(dimos).quiet().noThrow().spawn()
                try {
                    await page.waitForSelector("#status[data-status=connected]", { timeout: 90000 })
                    await demo.run(driver(page, demo.phone))
                    console.log(`   ${out}/${name}.mp4`)
                } catch (error) {
                    failed.push(name)
                    console.error(`   ${name} failed: ${error.message.split("\n")[0]}`)
                } finally {
                    const video = page.video()
                    await context.close()
                    const raw = await video.path()
                    await $`ffmpeg -y -loglevel error -i ${raw} -c:v libx264 -pix_fmt yuv420p -crf 22 -movflags +faststart ${out}/${name}.mp4`
                    await Deno.remove(raw)
                    await $`${bin}/dimos stop`.cwd(dimos).quiet().noThrow()
                    run.kill("SIGTERM")
                    await run.catch(() => {})
                }
            }
        } finally {
            await browser.close()
            await server.shutdown()
            gateway.kill("SIGTERM")
        }
        if (failed.length) {
            console.error(`failed: ${failed.join(", ")}`)
            Deno.exit(1)
        }
    })
    .parse(Deno.args)
