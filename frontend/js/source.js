// The orchestrator's TOML file over the graph: highlighted, and editable in place (a textarea over the highlighted
// copy, so the colors follow the typing). Apply sends it to the orchestrator, which checks it before using it.

import { h } from "./details.js"

/** TOML as colored spans: comments, [tables], keys, strings (CEL inside them stays a string), numbers, booleans. */
export function highlightToml(source) {
    const out = []
    const token = /(#[^\n]*)|("""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:[^"\\\n]|\\.)*"?|'[^'\n]*'?)|(^[ \t]*\[\[?[^\]\n]*\]\]?)|(^[ \t]*[A-Za-z0-9_.-]+(?=[ \t]*=))|\b(true|false)\b|(-?\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/gm
    let at = 0
    for (const match of source.matchAll(token)) {
        out.push(source.slice(at, match.index))
        const kind = ["", "t-com", "t-str", "t-table", "t-key", "t-bool", "t-num"][match.slice(1).findIndex((group) => group != null) + 1]
        out.push(h("span", { class: kind }, match[0]))
        at = match.index + match[0].length
    }
    out.push(source.slice(at))
    return out
}

export class SourceView {
    /**
     * @param {HTMLElement} container
     * @param {{ onApply: (source: string) => Promise<string[]> }} handlers resolves with the problems, [] once applied
     */
    constructor(container, handlers) {
        this.handlers = handlers
        this.source = ""
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
        this.element = h(
            "section",
            { class: "source", hidden: "" },
            h("div", { class: "src-bar" }, this.path, h("span", { class: "spacer" }), this.cancelButton, this.applyButton, this.editButton),
            h("div", { class: "src-editor" }, this.code, this.input),
            this.problems,
        )
        container.append(this.element)
    }

    get open() {
        return !this.element.hidden
    }

    show(open) {
        this.element.hidden = !open
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
        this.input.value = this.source
        this.paint(this.source)
    }

    paint(text) {
        // a trailing newline keeps the last line's height when the text ends in one
        this.code.replaceChildren(...highlightToml(text), "\n")
    }

    edit() {
        if (!this.editable) {
            return
        }
        this.editing = true
        this.element.classList.add("editing")
        this.input.removeAttribute("readonly")
        this.editButton.hidden = true
        this.applyButton.hidden = false
        this.cancelButton.hidden = false
        this.input.focus()
    }

    cancel() {
        this.finish()
        this.input.value = this.source
        this.paint(this.source)
    }

    finish() {
        this.editing = false
        this.element.classList.remove("editing")
        this.input.setAttribute("readonly", "")
        this.editButton.hidden = false
        this.applyButton.hidden = true
        this.cancelButton.hidden = true
        this.problems.hidden = true
    }

    async apply() {
        if (!this.editing) {
            return
        }
        const text = this.input.value
        this.applyButton.disabled = true
        try {
            const problems = await this.handlers.onApply(text)
            if (problems.length) {
                this.problems.replaceChildren(h("div", { class: "src-problems-title" }, "Not applied: the orchestrator found"), ...problems.map((problem) => h("div", { class: "src-problem" }, problem)))
                this.problems.hidden = false
                return
            }
            this.source = text
            this.finish()
        } catch (error) {
            this.problems.replaceChildren(h("div", { class: "src-problems-title" }, "Not applied"), h("div", { class: "src-problem" }, error.message))
            this.problems.hidden = false
        } finally {
            this.applyButton.disabled = false
        }
    }
}
