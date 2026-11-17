// The orchestrator's file over the graph, as its TOML or converted to YAML: highlighted, and editable in place (a
// textarea over the highlighted copy, so the colors follow the typing). Apply sends TOML to the orchestrator, which
// checks it before using it; a YAML edit is converted back to TOML first.

import { h } from "./details.js"
import { highlightOrchestratorYaml } from "./yaml_highlight.js"
import { isScalar, parseToml, parseYaml, stringifyToml, visitYaml, YamlDocument } from "../vendor/formats/formats.js"

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
    /**
     * @param {HTMLElement} container
     * @param {{ onApply: (source: string) => Promise<string[]> }} handlers resolves with the problems, [] once applied
     */
    constructor(container, handlers) {
        this.handlers = handlers
        this.source = ""
        this.format = "toml"
        this.editable = false
        this.code = h("pre", { class: "src-code", "aria-hidden": "true" })
        this.input = h("textarea", { class: "src-input", spellcheck: "false", "aria-label": "orchestrator file", readonly: "" })
        this.input.addEventListener("input", () => this.paint(this.input.value))
        this.input.addEventListener("scroll", () => {
            this.code.scrollTop = this.input.scrollTop
            this.code.scrollLeft = this.input.scrollLeft
        })
        this.input.addEventListener("keydown", (event) => {
            if (event.key === "Tab") {
                event.preventDefault()
                document.execCommand("insertText", false, "    ")
            } else if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                this.apply()
            } else if (event.key === "Escape") {
                this.cancel()
            }
        })
        this.path = h("span", { class: "src-path" })
        this.editButton = h("button", { class: "btn", type: "button", onclick: () => this.edit() }, "✎ Edit")
        this.applyButton = h("button", { class: "btn btn-primary", type: "button", hidden: "", onclick: () => this.apply() }, "Apply")
        this.cancelButton = h("button", { class: "btn", type: "button", hidden: "", onclick: () => this.cancel() }, "Cancel")
        this.problems = h("div", { class: "src-problems", hidden: "" })
        this.note = h("span", { class: "src-note", hidden: "" }, "saves as TOML: comments below the file's header are not kept")
        this.element = h(
            "section",
            { class: "source", hidden: "" },
            h("div", { class: "src-bar" }, this.path, h("span", { class: "spacer" }), this.note, this.cancelButton, this.applyButton, this.editButton),
            h("div", { class: "src-editor" }, this.code, this.input),
            this.problems,
        )
        container.append(this.element)
    }

    get open() {
        return !this.element.hidden
    }

    /** Open in `format` ("toml" or "yaml"), or close with `null`. An edit under way keeps its format. */
    show(format) {
        this.element.hidden = format == null
        if (format && format !== this.format && !this.editing) {
            this.format = format
            this.element.dataset.format = format
            this.input.setAttribute("aria-label", `orchestrator file as ${format.toUpperCase()}`)
            this.reset()
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

    reset() {
        this.input.value = this.text()
        this.paint(this.input.value)
    }

    /** What the blackboard knows (names and their kinds), so CEL in the YAML colors names as the blackboard does. */
    setNames(names) {
        this.names = names
        this.paint(this.input.value)
    }

    /** Editing needs an orchestrator to send the file to. */
    setEditable(editable) {
        this.editable = editable
        this.editButton.disabled = !editable
        this.editButton.title = editable ? "edit the file (applies to the running orchestrator)" : "connect to a running orchestrator to edit"
    }

    /** The file as the orchestrator has it; ignored while an edit is under way. */
    setSource(file, source) {
        this.path.replaceChildren(h("span", { dir: "ltr" }, file ?? ""))
        this.path.title = file ?? ""
        if (this.editing) {
            return
        }
        this.source = source ?? ""
        this.reset()
    }

    paint(text) {
        // a trailing newline keeps the last line's height when the text ends in one
        this.code.replaceChildren(...(this.format === "yaml" ? highlightOrchestratorYaml(text, this.names) : highlightToml(text)), "\n")
    }

    edit() {
        if (!this.editable) {
            return
        }
        this.editing = true
        this.element.classList.add("editing")
        this.input.removeAttribute("readonly")
        this.editButton.hidden = true
        this.note.hidden = this.format !== "yaml"
        this.applyButton.hidden = false
        this.cancelButton.hidden = false
        this.input.focus()
    }

    cancel() {
        this.finish()
        this.reset()
    }

    finish() {
        this.editing = false
        this.element.classList.remove("editing")
        this.input.setAttribute("readonly", "")
        this.editButton.hidden = false
        this.applyButton.hidden = true
        this.cancelButton.hidden = true
        this.note.hidden = true
        this.problems.hidden = true
    }

    async apply() {
        if (!this.editing) {
            return
        }
        let text = this.input.value
        if (this.format === "yaml") {
            try {
                // the file's opening comment block is carried over; comments further down are lost with the conversion
                const header = this.source.match(/^(?:[ \t]*(?:#[^\n]*)?\n)*/)[0]
                text = header + stringifyToml(parseYaml(text))
            } catch (error) {
                this.showProblems("Not applied: not valid YAML", [error.message])
                return
            }
        }
        this.applyButton.disabled = true
        try {
            const problems = await this.handlers.onApply(text)
            if (problems.length) {
                this.showProblems("Not applied: the orchestrator found", problems)
                return
            }
            this.source = text
            this.finish()
            this.reset()
        } catch (error) {
            this.showProblems("Not applied", [error.message])
        } finally {
            this.applyButton.disabled = false
        }
    }

    showProblems(title, problems) {
        this.problems.replaceChildren(h("div", { class: "src-problems-title" }, title), ...problems.map((problem) => h("div", { class: "src-problem" }, problem)))
        this.problems.hidden = false
    }
}
