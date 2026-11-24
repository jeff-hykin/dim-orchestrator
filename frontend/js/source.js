// The orchestrator's file over the graph, as its TOML or converted to YAML, highlighted. View only.

import { h } from "./details.js"
import { highlightOrchestratorYaml } from "./yaml_highlight.js"
import { isScalar, parseToml, visitYaml, YamlDocument } from "../vendor/formats/formats.js"

/** TOML text as YAML, lists of plain values kept on one line. */
export function tomlToYaml(source) {
    const document = new YamlDocument(parseToml(source))
    visitYaml(document, {
        Seq(_, node) {
            if (node.items.every(isScalar)) {
                node.flow = true
            }
        },
    })
    return document.toString({ lineWidth: 0 })
}

function paintTokens(source, token, kinds) {
    const out = []
    let at = 0
    for (const match of source.matchAll(token)) {
        out.push(source.slice(at, match.index))
        out.push(h("span", { class: kinds[match.slice(1).findIndex((group) => group != null)] }, match[0]))
        at = match.index + match[0].length
    }
    out.push(source.slice(at))
    return out
}

/** TOML as colored spans: comments, [tables], keys, strings (CEL inside them stays a string), numbers, booleans. */
export function highlightToml(source) {
    return paintTokens(source, /(#[^\n]*)|("""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:[^"\\\n]|\\.)*"?|'[^'\n]*'?)|(^[ \t]*\[\[?[^\]\n]*\]\]?)|(^[ \t]*[A-Za-z0-9_.-]+(?=[ \t]*=))|\b(true|false)\b|(-?\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/gm, ["t-com", "t-str", "t-table", "t-key", "t-bool", "t-num"])
}

export class SourceView {
    /** @param {HTMLElement} container */
    constructor(container) {
        this.source = ""
        this.format = "toml"
        this.code = h("pre", { class: "src-code" })
        this.path = h("span", { class: "src-path" })
        this.element = h(
            "section",
            { class: "source", hidden: "" },
            h("div", { class: "src-bar" }, this.path),
            h("div", { class: "src-editor" }, this.code),
        )
        container.append(this.element)
    }

    get open() {
        return !this.element.hidden
    }

    /** Open in `format` ("toml" or "yaml"), or close with `null`. */
    show(format) {
        this.element.hidden = format == null
        if (format && format !== this.format) {
            this.format = format
            this.element.dataset.format = format
            this.paint()
        }
    }

    /** The file in the format shown. */
    text() {
        if (this.format === "toml") {
            return this.source
        }
        try {
            return tomlToYaml(this.source)
        } catch (error) {
            return `# could not convert the file: ${error.message}\n`
        }
    }

    /** What the blackboard knows (names and their kinds), so CEL in the YAML colors names as the blackboard does. */
    setNames(names) {
        this.names = names
        this.paint()
    }

    setSource(file, source) {
        this.path.replaceChildren(h("span", { dir: "ltr" }, file ?? ""))
        this.path.title = file ?? ""
        this.source = source ?? ""
        this.paint()
    }

    paint() {
        const text = this.text()
        // a trailing newline keeps the last line's height when the text ends in one
        this.code.replaceChildren(...(this.format === "yaml" ? highlightOrchestratorYaml(text, this.names) : highlightToml(text)), "\n")
    }
}
