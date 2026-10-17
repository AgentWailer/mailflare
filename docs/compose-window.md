# Compose window and direct AI edits

The floating composer follows the supplied Gmail layout: a pale header with
minimize/expand/close controls, compact address and subject rows, a larger writing
area, a rounded writing-instruction field and a bottom action row. Send and its
schedule menu come first, followed by formatting, AI, attachments and links;
discard stays at the right. Formatting opens above the toolbar. On narrow phones,
links are available in that formatting panel. Touch targets remain at least 44px.
The existing sender picker, Cc/Bcc, attachments, templates, scheduled sending and
draft/reply metadata are retained. No unsupported Gmail buttons are introduced.

AI refinement immediately updates the editable body and the normal autosave
state. There is no separate preview or Replace step. A visible Undo action restores
the exact previous HTML; up to ten successive AI changes can be undone. Ctrl/Cmd+Z
in the body also undoes the latest AI change while it is still current. Further
manual edits invalidate that AI undo chain so it cannot overwrite newly typed
text. Changing the sending mailbox clears the chain.

The AI icon refines the current selection, otherwise the editable message. Empty
replies use the authorized conversation history. Empty new mail focuses the
writing-instruction field; submitting an instruction can generate a new body.
Instructions can also request edits to an existing body. Style and language are
chosen before generation and remembered locally. Generating temporarily blocks
editing and sending; Cancel aborts the request and ignores late responses. Errors
keep the original draft and offer retry. Sending always requires the normal Send
action and existing approval flow where applicable.

Signatures, quoted history and embedded images remain protected. The server uses
the existing configured model, mailbox permissions, origin checks, rate limiting
and usage accounting. Author instructions are separate from untrusted email
content; model output is escaped as text and validated for image placeholders.
The generation API never saves drafts or sends mail itself. No schema change is
needed.

Validation: `refine-api`, `refine-editor`, `refine-ui` and `compose-network-errors`
unit suites cover direct edits, selection, image/markup protection, permissions,
instructions, cancellation, stale replies, sequential undo and real autosave
payloads. `tests/browser/compose-window.mjs` uses the real form and production CSS
with synthetic APIs at 320/390/430/768/1024/1440px, light/dark themes, simulated
keyboard viewports, minimize/expand, prompt generation and reachable controls.
`reading-pane.mjs` also exercises replies and page composers. Browser emulation
does not certify a physical iPhone keyboard or the live provider's prose quality.

The production build, 37 targeted unit checks, seven composer browser cases and
29 reading-pane cases passed. The new AI/editor code passes targeted ESLint.
The global TypeScript check retains 15 pre-existing unrelated diagnostics; the
existing form and scheduling component retain their baseline four lint errors
and one warning. The change does not claim a clean global check.
