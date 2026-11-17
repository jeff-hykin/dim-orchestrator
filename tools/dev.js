#!/usr/bin/env -S deno run --allow-net --allow-read
// Serve the app the way Desktop does, without Desktop: the page at /apps/dim-orchestrator/, /theme.css, and
// /gateways/dimos/* proxied to a dimos gateway (python -m experimental.gateway --port <port> in a dimos checkout).

import { Command } from "jsr:@cliffy/command@1.0.0-rc.7"
import { serveDir } from "jsr:@std/http@1.0.10/file-server"

const here = new URL(".", import.meta.url).pathname
const frontend = `${here}../frontend`

export function startDevServer({ port, gateway, theme }) {
    return Deno.serve({ port, hostname: "127.0.0.1", onListen: () => {} }, async (request) => {
        const url = new URL(request.url)
        if (url.pathname === "/" || url.pathname === "/apps/dim-orchestrator") {
            return Response.redirect(new URL("/apps/dim-orchestrator/", url), 302)
        }
        if (url.pathname === "/theme.css") {
            if (theme) {
                const found = await fetch(theme).catch(() => null)
                if (found?.ok) {
                    return new Response(found.body, { headers: { "content-type": "text/css" } })
                }
            }
            return new Response(await Deno.readFile(`${here}dev/theme.css`), { headers: { "content-type": "text/css" } })
        }
        if (url.pathname.startsWith("/shell/fonts/") && theme) {
            // the theme's fonts, from the same Desktop
            const found = await fetch(new URL(url.pathname, theme)).catch(() => null)
            return found ?? new Response("no Desktop to serve fonts", { status: 404 })
        }
        if (url.pathname.startsWith("/gateways/dimos/")) {
            const target = new URL(url.pathname.slice("/gateways/dimos/".length) + url.search, gateway.endsWith("/") ? gateway : `${gateway}/`)
            try {
                return await fetch(target, {
                    method: request.method,
                    headers: { "content-type": request.headers.get("content-type") ?? "application/json" },
                    body: request.method === "GET" ? undefined : await request.arrayBuffer(),
                })
            } catch (error) {
                return Response.json({ error: `the dimos gateway at ${gateway} did not answer: ${error.message}` }, { status: 502 })
            }
        }
        if (url.pathname.startsWith("/apps/dim-orchestrator/")) {
            return serveDir(request, { fsRoot: frontend, urlRoot: "apps/dim-orchestrator", quiet: true })
        }
        return new Response("not found", { status: 404 })
    })
}

if (import.meta.main) {
    await new Command()
        .name("dev")
        .description("Serve the app with a dimos gateway behind it, at http://127.0.0.1:<port>/apps/dim-orchestrator/")
        .option("-p, --port <port:integer>", "port to serve on", { default: 8765 })
        .option("-g, --gateway <url:string>", "the dimos gateway", { default: "http://127.0.0.1:7811" })
        .option("-t, --theme <url:string>", "a Desktop's theme.css (falls back to tools/dev/theme.css)", { default: "http://127.0.0.1:5555/theme.css" })
        .action((options) => {
            startDevServer(options)
            console.log(`http://127.0.0.1:${options.port}/apps/dim-orchestrator/ (gateway ${options.gateway})`)
        })
        .parse(Deno.args)
}
