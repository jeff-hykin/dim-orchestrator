// CEL expressions highlighted with tree-sitter (bufbuild/tree-sitter-cel, built to wasm in vendor/), with every name
// the blackboard knows drawn as a pill that shows its value on hover.

import { Language, Parser, Query } from "../vendor/web-tree-sitter/tree-sitter.js"

let parser = null
let query = null

/** Load the parser once. Until it has loaded (or if it fails), expressions are drawn as plain text with pills. */
export const ready = (async () => {
    try {
        const base = new URL("../vendor/", import.meta.url)
        await Parser.init({ locateFile: (file) => new URL(`web-tree-sitter/${file}`, base).href })
        const language = await Language.load(new URL("tree-sitter-cel/tree-sitter-cel.wasm", base).href)
        const highlights = await (await fetch(new URL("tree-sitter-cel/highlights.scm", base))).text()
        parser = new Parser()
        parser.setLanguage(language)
        query = new Query(language, highlights)
    } catch (error) {
        console.warn("CEL highlighting is off:", error)
    }
})()

/** Leaf tokens of a source, each with the first highlight capture that covers it. */
function tokens(source) {
    if (!parser) {
        return [...source.matchAll(/[A-Za-z_]\w*|\d+(?:\.\d+)?|'[^']*'|"[^"]*"|\s+|./g)].map((match) => ({
            text: match[0],
            start: match.index,
            type: /^[A-Za-z_]/.test(match[0]) ? "identifier" : match[0] === "." ? "." : "other",
            capture: /^[A-Za-z_]/.test(match[0]) ? "variable" : /^['"]/.test(match[0]) ? "string" : /^\d/.test(match[0]) ? "number" : "",
        }))
    }
    const tree = parser.parse(source)
    const captureAt = new Map()
    for (const { name, node } of query.captures(tree.rootNode)) {
        const key = `${node.startIndex}:${node.endIndex}`
        if (!captureAt.has(key)) {
            captureAt.set(key, name)
        }
    }
    const leaves = []
    const walk = (node) => {
        if (node.childCount === 0 || node.type === "string_literal" || node.type === "bytes_literal") {
            leaves.push(node)
            return
        }
        for (let i = 0; i < node.childCount; i++) {
            walk(node.child(i))
        }
    }
    walk(tree.rootNode)
    const found = []
    let at = 0
    for (const leaf of leaves) {
        if (leaf.startIndex > at) {
            found.push({ text: source.slice(at, leaf.startIndex), start: at, type: "space", capture: "" })
        }
        if (leaf.endIndex <= leaf.startIndex) {
            continue
        }
        found.push({
            text: source.slice(leaf.startIndex, leaf.endIndex),
            start: leaf.startIndex,
            type: leaf.type,
            capture: captureAt.get(`${leaf.startIndex}:${leaf.endIndex}`) ?? (leaf.isError ? "error" : ""),
        })
        at = leaf.endIndex
    }
    if (at < source.length) {
        found.push({ text: source.slice(at), start: at, type: "space", capture: "" })
    }
    tree.delete()
    return found
}

/**
 * An expression as DOM: highlighted tokens, known names as pills.
 * @param {string} source
 * @param {{ known: Set<string>, kindOf: (name: string) => string }} names
 */
export function renderCel(source, names) {
    const root = document.createElement("span")
    root.className = "cel"
    const list = tokens(String(source))
    for (let i = 0; i < list.length; i++) {
        const token = list[i]
        const isName = token.type === "identifier" && token.capture !== "function.call" && token.capture !== "function.method.call"
        const afterDot = i > 0 && list[i - 1].type === "."
        if (isName && !afterDot) {
            // A dotted chain (patrol.index, nav_status.goal_id.stamp): the longest known prefix is the pill.
            const chain = [i]
            while (list[chain.at(-1) + 1]?.type === "." && list[chain.at(-1) + 2]?.type === "identifier") {
                chain.push(chain.at(-1) + 2)
            }
            let best = -1
            for (let k = chain.length - 1; k >= 0; k--) {
                const name = list.slice(i, chain[k] + 1).map((t) => t.text).join("")
                if (names.known.has(name)) {
                    best = k
                    break
                }
            }
            if (best >= 0) {
                const end = chain[best]
                const name = list.slice(i, end + 1).map((t) => t.text).join("")
                root.append(pill(name, names.kindOf(name)))
                i = end
                continue
            }
        }
        const span = document.createElement("span")
        span.textContent = token.text
        if (token.capture) {
            span.className = `tok-${token.capture.replaceAll(".", "-")}`
        }
        root.append(span)
    }
    return root
}

export function pill(name, kind) {
    const span = document.createElement("span")
    span.className = `pill pill-${kind}`
    span.dataset.key = name
    span.textContent = name
    return span
}
