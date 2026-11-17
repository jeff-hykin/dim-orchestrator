// A value drawn for people rather than for JSON readers: no braces or quotes, an object as a table of its fields, a
// list as a row of items that turns into a column once it no longer fits on one line.

import { h } from "./details.js"

/** @returns {HTMLElement} */
export function renderFriendly(value) {
    if (value === null || value === undefined) {
        return h("span", { class: "fj-empty" }, "empty")
    }
    if (typeof value === "boolean") {
        return h("span", { class: `fj-bool fj-${value}` }, value ? "✓ true" : "✗ false")
    }
    if (typeof value === "number") {
        return h("span", { class: "fj-num" }, Number.isInteger(value) ? value.toLocaleString() : (+value.toFixed(4)).toLocaleString(undefined, { maximumFractionDigits: 4 }))
    }
    if (typeof value === "string") {
        return value === "" ? h("span", { class: "fj-empty" }, "empty text") : h("span", { class: "fj-str" }, value)
    }
    if (Array.isArray(value)) {
        if (!value.length) {
            return h("span", { class: "fj-empty" }, "empty list")
        }
        return h("ol", { class: "fj-list fj-inline" }, ...value.map((item) => h("li", { class: "fj-item" }, renderFriendly(item))))
    }
    const entries = Object.entries(value)
    if (!entries.length) {
        return h("span", { class: "fj-empty" }, "nothing")
    }
    return h("div", { class: "fj-table" }, ...entries.flatMap(([key, item]) => [h("span", { class: "fj-key" }, key), h("div", { class: "fj-value" }, renderFriendly(item))]))
}

/** Turn every list that runs past its box into a column, outermost first (so an inner list measures in the width its
 * parent leaves it), once it is on screen. */
export function fitLists(root) {
    for (const list of root.querySelectorAll(".fj-list")) {
        list.classList.replace("fj-column", "fj-inline")
        if (list.scrollWidth > list.clientWidth + 1) {
            list.classList.replace("fj-inline", "fj-column")
        }
    }
}
