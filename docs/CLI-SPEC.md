```
  ▄██▀ ▀█  ▄██▀ █▄  ▀██  ██▀  ▄██▀ ▀█  ▄██▀ █▄   █▄   ▄█
 ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒  ▒▒  ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒▒▄▒▒▒
 ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒▌ ▒▒  ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒ ▀ ▒▒
  ▀██▄ ▄█  ▀██▄ █▀    ▀█▄▀    ▀██▄ ▄█  ▀██▄ █▀  ▄██▄ ▄██▄

XChaCha20 · ML-KEM-768 · Ed25519 · BLAKE3 · SPQR · E2EE · ephemeral · N-party
```

# COVCOM CLI TUI Design Spec

cli app design doc. covers architecture, rendering, input, widgets, views, and color system.

> [!NOTE]
> This is an internals deep-dive. Installing, running, the invocation flags, and
> the config file all live in [USAGE](./USAGE.md).

---

## goals

- zero dependencies. `process.stdin`, `process.stdout`, ANSI escapes only.
- compiles clean with `bun build --compile` on all targets (wasm compatible).
- works in tmux, ssh, xterm, alacritty, kitty, ghostty, wezterm.
- keyboard-primary navigation. mouse as a convenience layer on top.
- color-fill rendering. no box drawing chars on interactive widgets.
- exception: the crypto info table in WaitingView uses box drawing. it is the only
  place in the app where box drawing chars appear.
- lean and app-specific. not a framework.

---

## module map

```
src/tui/
├── screen.ts     terminal primitives, alternate buffer, cursor, fill, ANSI helpers, theme + color system
├── keys.ts       raw keypress + mouse event parser
├── focus.ts      focus ring, tab/shift-tab cycling, direct set-by-id
├── banner.ts     the ASCII banner string drawn at the top of the lobby views
├── qr.ts         half-block terminal renderer for the shared qrMatrix encoder
├── widgets.ts    TextInput, TextArea, Button, ScrollView, Sidebar, drawModal, markup + wrap helpers
├── views.ts      renderLanding, renderCreate, renderWaiting, renderJoin, renderChat
├── landing.ts    barrel: re-exports renderLanding, renderCreate from views.ts
├── join.ts       barrel: re-exports renderJoin from views.ts
├── waiting.ts    barrel: re-exports renderWaiting from views.ts
└── chat.ts       barrel: re-exports renderChat, appendMessage, appendFile, showModal from views.ts
```

views are render functions, not classes. each one wires up its widgets and a
`FocusRing`, then hands a render callback and an input handler to the shared
`setupView`, which owns the stdin/resize listeners and the render loop.
`state.ts` drives the transitions by calling the next render function. the
barrels exist so `state.ts` imports each view from a file named for it; they add
no behavior.

```
Landing → Create → Waiting → Chat   (create room)
Landing → Join → Chat               (join room)
```

Create and Join both return to Landing on Cancel. Waiting returns to Landing on
Cancel. Waiting advances to Chat automatically when a peer connects, and Join
advances to Chat once the invite parses and the connection succeeds, both driven
by `state.ts`.

---

## screen

one instance for the app lifetime. owns the terminal.

```ts
class Screen {
  w = 80   // columns, until the first measure() reports the real size
  h = 24   // rows
  private dirty = true

  constructor() {
    process.stdout.write('\x1b[?1049h')   // enter alternate buffer
    process.stdout.write('\x1b[?25l')     // hide cursor
    process.stdout.write('\x1b[?1006h')   // SGR mouse mode
    process.stdout.write('\x1b[?1000h')   // enable mouse click reporting
    process.stdout.write('\x1b[?2004h')   // bracketed paste mode
    process.stdin.setRawMode(true)
    process.stdin.resume()
    this.measure()
    process.stdout.on('resize', () => { this.measure(); this.markDirty() })
  }

  measure() {
    this.w = process.stdout.columns || 80
    this.h = process.stdout.rows    || 24
  }

  moveTo(x: number, y: number) {
    process.stdout.write(`\x1b[${y};${x}H`)
  }

  // fill a rectangle with a bg color. used for all widget backgrounds.
  // bg is a ColorValue (see the color system), so the helper resolves ansi16,
  // 256, hex, or null via colorBg().
  fillRect(x: number, y: number, w: number, h: number, bg: ColorValue) {
    const bgSeq = colorBg(bg)
    const row = ' '.repeat(Math.max(0, w))
    for (let r = 0; r < h; r++) {
      this.moveTo(x, y + r)
      process.stdout.write(bgSeq + row + ansi.reset)
    }
  }

  write(s: string) { process.stdout.write(s) }
  markDirty()      { this.dirty = true }
  needsRender(): boolean {
    if (!this.dirty) return false
    this.dirty = false
    return true
  }

  beginRender() { process.stdout.write('\x1b[?2026h') }  // synchronized output begin
  endRender()   { process.stdout.write('\x1b[?2026l') }  // synchronized output end

  clear() { process.stdout.write('\x1b[2J') }

  showCursor(x: number, y: number) {
    this.moveTo(x, y)
    process.stdout.write('\x1b[?25h')
  }

  hideCursor() { process.stdout.write('\x1b[?25l') }

  destroy() {
    process.stdout.write('\x1b[?25h')     // show cursor
    process.stdout.write('\x1b[?1049l')   // leave alternate buffer
    process.stdout.write('\x1b[?1006l')   // disable SGR mouse
    process.stdout.write('\x1b[?1000l')   // disable mouse reporting
    process.stdout.write('\x1b[?2004l')   // disable bracketed paste
    process.stdin.setRawMode(false)
  }
}
```

### ANSI helpers

target the user's terminal 16-color palette via basic ANSI codes (not 256-color
indices 0-15, which can get remapped in tmux/ssh chains).

```ts
const ansi = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  italic: '\x1b[3m',

  // fg: 0-7 normal, 8-15 bright
  fg(n: number): string {
    return n < 8 ? `\x1b[${30 + n}m` : `\x1b[${90 + n - 8}m`
  },

  // bg: 0-7 normal, 8-15 bright
  bg(n: number): string {
    return n < 8 ? `\x1b[${40 + n}m` : `\x1b[${100 + n - 8}m`
  },

  // truecolor fallback for user overrides
  fgHex(hex: string): string { /* parse + emit \x1b[38;2;r;g;bm */ },
  bgHex(hex: string): string { /* parse + emit \x1b[48;2;r;g;bm */ },
} as const
```

user settings can override any color slot to a 256-color index (`{ type: '256', n: 214 }`)
or truecolor hex (`{ type: 'hex', value: '#ff8800' }`). the renderer checks the slot
type and calls the appropriate helper.

---

## input

### key events

```ts
type Key = {
  name:  string    // 'a', 'enter', 'tab', 'up', 'backspace', 'escape', etc.
  ch?:   string    // printable character if applicable
  ctrl:  boolean
  shift: boolean
  meta:  boolean   // alt key
}
```

key cases handled:

- ctrl+c → exit
- arrow keys, both normal (`\x1b[A/B/C/D`) and application-cursor (`\x1bOA/B/C/D`)
- shift+tab (`\x1b[Z`)
- home/end (`\x1b[H`, `\x1b[F`, `\x1b[1~`, `\x1b[4~`)
- pageup/pagedown (`\x1b[5~`, `\x1b[6~`)
- delete (`\x1b[3~`), insert (`\x1b[2~`)
- enter (`\r`, `\r\n`), tab (`\t`), backspace (`\x7f`, `\x08`), escape (`\x1b`)
- ctrl+letter (bytes 0x01-0x1a)
- bracketed paste: `\x1b[200~` ... `\x1b[201~` → emitted as a single `paste` event
  with the full pasted string, never parsed as individual keystrokes
- printable chars: a single code point is a keypress; an unbracketed multi-code-point
  run is treated as a `paste` event, the fallback for terminals without bracketed paste

### mouse events

SGR format: `\x1b[<Cb;Cx;CyM` (button down) / `\x1b[<Cb;Cx;Cym` (button up).
decimal coords. unambiguous. works in tmux.

```ts
type MouseEvent = {
  type:   'click' | 'release' | 'scroll'
  button: number   // 0=left, 1=middle, 2=right, 64=scroll-up, 65=scroll-down
  x:      number   // 1-indexed column
  y:      number   // 1-indexed row
}
```

the parser in `keys.ts` checks the incoming buffer: if it starts with `\x1b[<`
it's a mouse event, otherwise key. both are emitted through a single `InputEvent`
union type to the view.

```ts
type InputEvent =
  | { kind: 'key',   key:   Key }
  | { kind: 'mouse', mouse: MouseEvent }
  | { kind: 'paste', text:  string }
```

---

## focus ring

```ts
class FocusRing {
  private items: string[] = []   // widget ids in tab order
  private idx = 0

  register(id: string) { this.items.push(id) }
  clear()              { this.items = []; this.idx = 0 }
  current()            { return this.items[this.idx] }
  isFocused(id: string){ return this.items[this.idx] === id }

  next() { this.idx = (this.idx + 1) % this.items.length }
  prev() { this.idx = (this.idx - 1 + this.items.length) % this.items.length }

  // used by mouse click to directly focus a widget without cycling
  setById(id: string) {
    const i = this.items.indexOf(id)
    if (i !== -1) this.idx = i
  }
}
```

views own a `FocusRing` and register widgets in tab order during init. Tab calls
`next()`, shift+tab calls `prev()`, mouse clicks call `setById()`.

---

## widgets

### interface

```ts
type Rect = { x: number; y: number; w: number; h: number }

interface Widget {
  id:     string
  rect:   Rect          // written by render(), read by hit test
  render(scr: Screen, rect: Rect, focused: boolean, theme: Theme): void
  onKey(key: Key): boolean     // return true if consumed
  onPaste?(text: string): void
  onClick?(): void             // optional. buttons, attachment chips define it.
}
```

`rect` is always written at the top of `render()` before drawing anything.
this is what makes hit testing work. After every render pass, every widget's
`rect` reflects where it currently lives on screen.

### `TextInput`

single-line. tracks value + cursor position.

- renders as `fillRect` with `inputBg`, then writes value text in `inputFg`
- cursor shown as the character at cursor position rendered with inverted colors,
  or a space if at end of string
- backspace, delete, left/right arrows, home/end, ctrl+a/e, ctrl+k (clear to end),
  ctrl+u (clear to start) all handled
- optional `mask` flag renders every character as `*` (the Create view's Server
  Password field uses it, matching the web client's `type="password"`). the
  stored value stays plaintext; masking is display-only
- enter: does not consume, propagates to view to trigger form action
- paste: strips newlines, then inserts at cursor position

### `TextArea`

multiline. used for the invite paste box in the Join view. the FilePicker path
field is a single-line `TextInput`, not a `TextArea`.

- same as TextInput but enter inserts `\n` instead of propagating
- tracks lines + vertical scroll offset
- up/down arrows move between lines, home/end jump within the current line
- delete and backspace both handled
- paste inserts verbatim, newlines included (bun delivers pasted text as a
  single data event)

### `Button`

```ts
class Button implements Widget {
  id:       string
  label:    string
  rect:     Rect = { x:0, y:0, w:0, h:0 }
  disabled: boolean = false
  bar:      boolean = false   // true for the send/attach/ratchet/cancel bar buttons
  action:   () => void

  render(scr: Screen, rect: Rect, focused: boolean, theme: Theme) {
    this.rect = rect
    // bar buttons draw from the bar palette (barBtn*) so they blend into the
    // chat input bar; everything else uses the standard btn* slots.
    const bg = this.disabled ? theme.btnDisabledBg
             : focused       ? (this.bar ? theme.barBtnFocusBg : theme.btnFocusBg)
             :                 (this.bar ? theme.barBtnBg      : theme.btnBg)
    const fg = this.disabled ? theme.btnDisabledFg
             : focused       ? (this.bar ? theme.barBtnFocusFg : theme.btnFocusFg)
             :                 (this.bar ? theme.barBtnFg      : theme.btnFg)
    scr.fillRect(rect.x, rect.y, rect.w, rect.h, bg)
    // write label centered within rect
    const label = ` ${this.label} `
    const lx = rect.x + Math.floor((rect.w - label.length) / 2)
    const ly = rect.y + Math.floor(rect.h / 2)
    scr.moveTo(lx, ly)
    scr.write(ansi.bg(bg) + ansi.fg(fg) + label + ansi.reset)
  }

  onClick() { if (!this.disabled) this.action() }
  onKey(key: Key): boolean {
    if ((key.name === 'enter' || key.name === 'space') && !this.disabled) {
      this.action()
      return true
    }
    return false
  }
}
```

disabled buttons render with `btnDisabledFg === btnDisabledBg`. The label is
invisible, just a gray slab. clearly inert.

### `ScrollView`

chat message display. stores messages, not pre-rendered lines, and recomputes
the wrapped lines on every render so a resize reflows for free.

```ts
type StoredMsg =
  | { isFile: false; sender: string; text: string; isSelf: boolean
      senderIndex: number; system?: boolean; ratchet?: boolean; ratchetIcon?: string }
  | { isFile: true; sender: string; filename: string; size: number; mime: string
      isSelf: boolean; senderIndex: number; saved?: string
      download?: () => Promise<string> }

type RenderedLine = {
  screenY:     number   // row this line was drawn at during the last render
  attachment?: {        // present only on an attachment-chip row
    filename: string
    chipX1:   number    // absolute screen column the chip starts at
    chipX2:   number    // absolute screen column the chip ends at
    saved?:   string    // local path once the file has been written
    msgIdx:   number    // index into msgs[], for selection + download
  }
}
```

key behaviors:

- new messages appended to `msgs[]`. each body is sanitized for terminal escape
  injection (ANSI/CSI/OSC sequences, stray control bytes, and the shared
  bidi/zero-width spoofing characters from
  [LIB-SPEC § sanitize](./LIB-SPEC.md#sanitize) are stripped), then parsed by
  the shared markup model ([LIB-SPEC § markup](./LIB-SPEC.md#markup)) and
  rendered to our own SGR: bold (`*`), italic (`_`), bold+italic (`_*`/`*_`),
  inline code, and fenced ` ``` ` blocks. the web client renders the same token
  tree to DOM instead; see [WEB-SPEC § rendering](./WEB-SPEC.md#rendering). peer
  usernames and filenames pass through the same sanitizer before they reach the
  buffer, so their visible width drives the prefix and chip math correctly.
- the sender prefix `name: ` is colored by sender: self uses `peer0`, peers use
  their assigned `peerColor`, and a system message uses `system`. the body uses
  `yourMsg` for self, `peerMsg` for peers, and `system` for system messages.
- a ratchet notice (`ratchet: true`) renders as a single clipped line: the
  sender, an optional key icon in `keyFg`, and the text in `ratchetTxtFg`.
- wrapping counts display columns, not code points, so CJK and wide emoji wrap
  and pad correctly and a surrogate pair is never severed
- `autoScroll = true` by default, so new messages scroll to bottom
- scrolling up (keyboard or mouse wheel) disables autoScroll
- scrolling back to bottom re-enables autoScroll
- during render, fills each visible row at the theme `bg`, writes line content,
  and populates `renderedLines[]` as it goes
- scroll indicator: single `█` on the right edge, positioned proportionally

**attachment chip rendering:**

an attachment line is the colored sender prefix, then a filled chip, then a
dimmed byte count:

```
  alice: filename.ext (12.4 KB)
         ^          ^ ^        ^
       attachBg   reset disabled
```

the chip is ` filename ` painted on `attachBg`/`attachFg`. when the attachment is
the selected one (msgArea focused), it switches to `attachSelectedBg`/
`attachSelectedFg`. the byte count is `formatBytes(size)` in the `disabled`
color. `renderedLines[]` records the chip's absolute column range and `msgIdx`
so hit testing and keyboard selection can find it.

**hit testing:**

```ts
hitTest(x: number, y: number): { attachment: RenderedLine['attachment'] } | null {
  for (const rl of this.renderedLines) {
    if (rl.screenY === y && rl.attachment &&
        x >= rl.attachment.chipX1 && x <= rl.attachment.chipX2)
      return { attachment: rl.attachment }
  }
  return null
}
```

**keyboard:** when the buffer has at least one attachment, up/down move the
attachment selection and Enter downloads the selected file (calls its `download`
callback, then records the saved path via `markSaved`). with no attachments,
up/down scroll by 1. pgup/pgdn always scroll by 10. the view routes these to
scrollView only when it is focused.

**mouse wheel:** scroll events whose `(x, y)` falls inside `scrollView.rect` always
route to scrollView regardless of focus.

### `Sidebar`

two-mode side pane mirroring the web client's sidebar
([WEB-SPEC § sidebar, event log, verify](./WEB-SPEC.md#sidebar-event-log-verify)).
either hidden, or showing the `event-log` (live session activity feed), or
showing `verify` (the
local + per-peer fingerprints as colored swatches + hex). data comes from the
shared `eventLog.ts` ring buffer (subscribed to in `attach()`) and a
`getFingerprints()` callback from `state.ts`. width is a percentage of the
screen, persisted to the config file under `sidebar.width` (see
[USAGE configuration](./USAGE.md#configuration) for the path resolution).

```ts
type SidebarMode = 'event-log' | 'verify' | null

class Sidebar implements Widget {
  id    = 'sidebar'
  rect: Rect
  mode:  SidebarMode
  width: number       // bounded by SIDEBAR_WIDTH_MIN..MAX (10..70)

  setMode(m: SidebarMode): void
  isOpen(): boolean
  setWidth(w: number): number
  stepWidth(direction: -1 | 1): number
  scrollByLines(delta: number): void

  attach(onChange: () => void): () => void  // subscribes to event-log; returns dispose
  dispose(): void
}
```

the first body row is a tab strip: ` events ` and ` verify `, the active mode
filled with `btnFocusBg`/`btnFocusFg` and the inactive one with `btnBg`/`btnFg`.
the mode's content fills the rows beneath it.

event-log row layout (one line per entry, expanded entries insert detail
lines beneath the header):

```
HH:MM:SS  →  message    you: hello there
HH:MM:SS  ←  ratchet    peer1: keys rotated
HH:MM:SS  ·  join       peer2 joined
```

- direction glyph: `→` out, `←` in, `·` local
- `kind` column padded to 9 cols and colored by class: member kinds (`join`,
  `part`, `rejoin`, `peer_joined`, `peer_left`) use `evtKindMember`, ratchet
  kinds use `evtKindRatchet`, error kinds (`error`, `fatal`, `decrypt-fail`,
  `send-fail`, and the like) use `evtKindError`, everything else `evtKindDefault`
- summary truncated to remaining width with a trailing `…`. when it parses as
  `name: rest`, the name is colored `evtSelf` for you or `evtPeer` for a peer
- selected row (when sidebar focused) gets a `btnFocusBg` fill
- enter on selected row toggles `expanded`; details render as `  key: value`
  lines beneath the row, the key in `evtKey` and the value in `evtVal`
- auto-scrolls to bottom unless the user has scrolled away from the tail

verify layout: ` You` heading, up to 8 colored 2-col swatches drawn with
truecolor hex from `FingerprintSurface.swatches[]`
([LIB-SPEC § fingerprints](./LIB-SPEC.md#fingerprints), as many as fit the pane
width), 16-char hex below. blank line, then each peer in the same shape under
their username heading, or `(no peers yet)` when none have joined. no
`[verified]` marker; verification is out-of-band, matching the web.

**toggling and keybindings (handled in `renderChat`):**
- the keys-display (`E`/`V`) and the `/events` / `/verify` commands toggle the
  panel via `toggleMode`. open/switch/close semantics: closed → open in
  event-log; open in verify → switch to event-log; open in event-log → close.
  `verify` is the same with the modes swapped.
- when sidebar is focused: `↑/↓` move selection, `PgUp/PgDn` page, `Home/End`
  jump, `Enter` expand/collapse the selected entry's details, `Esc` close.
- when sidebar is focused: `+` widens by `SIDEBAR_WIDTH_STEP` (5%), `-` narrows
  by the same. changes persist immediately via `writeSidebarWidth`. width
  stepping is gated on focus so `+`/`-` still work as normal characters in
  the chat input.
- mouse wheel over the sidebar scrolls the event log (line-by-line, 3 lines
  per tick), regardless of focus.

**narrow-terminal takeover:** when `screen.w < SIDEBAR_MIN_COLS` (80), there is
no room for a split, so an open sidebar takes the full screen width and the chat
is hidden behind it (rather than the sidebar silently never opening). the
keys-display or the `/events` / `/verify` commands open it, `Esc` and `Tab` both
close it and return focus to the chat input, and resizing past the threshold
snaps back to the side-by-side layout with focus intact. while full-width the
focus ring holds only the sidebar.

### keys-display (modal)

a vim-style modal entered by pressing `Esc` while the chat input is focused. it
replaces the input bar (the row, not the message scroll) with a row of action
units and is the keyboard path to ratchet / events / verify. scope is the chat
input only: the `Esc` that opens it is gated on `chatInput` focus, so it does
not collide with the sidebar/msgArea `Esc` handlers.

units, left to right: `R` ratchet, `E` events, `V` verify, `ESC` return to chat.
each unit is `space icon space [ KEY ] space Label space` painted on `barBtnBg`,
the icon in `barBtnFg`, the ` KEY ` block in `barBtnFocusBg`/`barBtnFocusFg`, and
the label in `barBtnFg` with a bold capitalized first letter; units are
separated by a single `barBg` space. the icon comes from the matching
`config.icons` entry read raw (no default): an unset icon renders nothing and
skips its bookend space, so `icons.ratchet` shows here only when explicitly set
(distinct from the bar button, which falls back to `R`). `keyHints()` builds the
unit list and is unit-tested.

while shown only the action keys and `Esc` are live (shift-insensitive); every
other key is swallowed. every action closes the modal: `R` ratchets and returns
focus to the input, `E`/`V` toggle the panel via `toggleMode` and defer to its
focus move (sidebar on open, input on close), and `Esc` just returns to the
input. `Ctrl+C` still quits. the modal is also dropped when focus leaves the
input (Tab, click) or the layout collapses to full-width. the web client
reaches the same three actions through its own Escape-opened keys modal; see
[WEB-SPEC § chat](./WEB-SPEC.md#chat).

### `FilePicker`

takes over the chat bar area when the `+` button is activated. not a standalone
widget so much as a mode the ChatView enters.

visual: replaces `[input] [>] [+]` with `[path input] [x]`

the path input is a `TextInput` with tab-completion behavior layered on top:

- on Tab keypress, reads the current value up to the last `/`, calls `fs.readdirSync`
  on that directory (or cwd if no `/`), filters entries by the typed prefix
- each Tab replaces the value with the next match and cycles through them. the
  match set is recomputed whenever the value changes from the last completion.
  longest-common-prefix completion is deferred (see open / deferred)
- Esc: cancel, restore normal bar
- Enter: confirm path, exit FilePicker mode, trigger upload callback

on Enter, the resolved path is validated before upload: if it does not point at
an existing file (missing path, or a directory), a `File Not Found` modal is
shown with an error-colored border and the upload is aborted. the FilePicker
stays open with the typed value intact so the path can be corrected. this guards
against tab-completion leaving a partial or wrong path that would otherwise be
transmitted as a 0-byte file.

no file tree. no GUI. just a text input that knows about the filesystem. the
web client attaches through drag-drop and a native file picker instead
([WEB-SPEC § chat](./WEB-SPEC.md#chat)).

---

## views

each view is a render function (`renderLanding`, `renderCreate`, `renderWaiting`,
`renderJoin`, `renderChat`). a view:
- builds its widgets and a `FocusRing` in tab order
- computes layout from `screen.w` / `screen.h` on each render
- passes a render callback and an input handler to the shared `setupView`

`setupView` owns the stdin and resize listeners and the render loop. the input
handler delegates the `InputEvent` to the focused widget first, then falls back
to global keys (Tab, Shift+Tab, Ctrl+C). it also runs the shared modal layer: a
single modal can overlay any view, and while one is shown every key dismisses it
except Ctrl+C. the first Ctrl+C arms a `quit covcom?` confirm modal; a second
Ctrl+C emits `SIGINT` and exits.

the lobby views (Landing, Create, Join) draw the ASCII banner from `banner.ts`
above their form when the terminal is tall and wide enough; it is skipped
silently otherwise.

### `renderLanding`

the entry view. collects a username and routes to Create or Join. server DNS and
the optional auth token moved to the Create view, so Landing is just the name and
the two paths. the web client folds Landing, Create, and Join into one view with
three sub-screens; see [WEB-SPEC § landing and join](./WEB-SPEC.md#landing-and-join).

```
layout (centered on screen):
  content width = min(screen.w - 8, 44)
  origin x      = Math.floor((screen.w - contentW) / 2)
  origin y      = Math.max(1, Math.floor((screen.h - 8) / 2))

  label "Username:"            @ (ox, oy)
  usernameInput  [TextInput]   @ (ox, oy+1)      h=1
  createBtn      [Button]      @ (ox, oy+3)      w=14  label="Create Room"
  joinBtn        [Button]      @ (ox+16, oy+3)   w=12  label="Join Room"
  errorLine                    @ (ox, oy+5)      shown in theme.error when set

tab order: usernameInput → createBtn → joinBtn
```

either button requires a non-empty username, surfacing `Username is required`
inline when blank. enter on the username input advances focus (same as Tab).

### `renderCreate`

reached from Landing's Create Room. collects the server and confirms the
username, with an optional masked password behind an Advanced toggle.

```
layout (centered on screen):
  content width = min(screen.w - 8, 44)
  origin x      = Math.floor((screen.w - contentW) / 2)
  origin y      = Math.max(1, Math.floor((screen.h - 16) / 2))

  label "Username:"                     @ (ox, oy)
  usernameInput  [TextInput]            @ (ox, oy+1)    h=1
  label "Server DNS:"                   @ (ox, oy+3)
  serverInput    [TextInput]            @ (ox, oy+4)    h=1
  advancedBtn    [Button]               @ (ox, oy+6)    w=14  label="Advanced >"

  if expanded:
    label "Server Password (optional):" @ (ox, oy+8)
    tokenInput   [TextInput, masked]    @ (ox, oy+9)    h=1
    createBtn / cancelBtn               @ row oy+11
  else:
    createBtn / cancelBtn               @ row oy+8

  createBtn      [Button]               w=14  label="Create Room"
  cancelBtn      [Button]               w=10  label="Cancel"

tab order: usernameInput → server → advanced [→ authToken] → create → cancel
```

the token row joins the focus ring only while expanded, so Tab never lands on a
hidden field. Create requires both server and username, surfacing
`Server and username are required` when either is blank. system errors from the
connect attempt (server error, connection failed, version mismatch) render
inline via `_errorDisplay`, so the user stays here with their entries intact.
Cancel returns to Landing.

### `renderJoin`

reached from Landing's Join Room. takes an invite, either pasted or loaded from a
`.room` file.

```
layout (centered on screen):
  content width = min(screen.w - 8, 52)
  origin x      = Math.floor((screen.w - contentW) / 2)
  origin y      = Math.max(1, Math.floor((screen.h - 22) / 2))

  label "Username:"             @ (ox, oy)
  usernameInput  [TextInput]    @ (ox, oy+1)     h=1
  label "Path to .room file:"   @ (ox, oy+3)
  pathInput      [TextInput]    @ (ox, oy+4)     h=1
  browseBtn      [Button]       @ (ox, oy+6)     w=10  label="Browse"
  label "Or paste invite text:" @ (ox, oy+8)
  inviteArea     [TextArea]     @ (ox, oy+9)     w=cw  h=5
  errorLine                     @ (ox, oy+15)    shown in theme.error when set
  joinBtn        [Button]       @ (ox, oy+17)    w=12  label="Join Room"
  cancelBtn      [Button]       @ (ox+14, oy+17) w=10  label="Cancel"

tab order: username → path → browse → invite → join → cancel
```

`inviteArea` is the single source the invite parses from. Browse reads the file
at `pathInput` into `inviteArea`; a `prefillPath` is loaded into it on mount. Join
Room requires a username and non-empty invite text, then parses it with
`parseArmoredInvite` ([LIB-SPEC § invites](./LIB-SPEC.md#invites)), surfacing
any parse or read error inline. there is no
separate parse step and no disabled-until-loaded button; parsing happens on the
Join Room click. Cancel returns to Landing.

### `renderWaiting`

shown after Create Room succeeds. receives `armoredInvite`, `roomId`, and an
`onCancel`. transitions automatically to Chat when a peer connects (driven by
state.ts). the block stacks, centered, top to bottom: heading, subhead, a row of
three buttons, an optional scannable QR, and the crypto table.

```
heading "Room Code Generated Successfully"   bold, fg=fg
subhead "Waiting for peer(s) to connect..."  fg=disabled

copyBtn      [Button]  w=14  label="Copy Code"
downloadBtn  [Button]  w=14  label="Download"
cancelBtn    [Button]  w=10  label="Cancel"

QR     optional, centered one blank row above the table (see below)

table  the shared crypto table (see below)
  ┌───────────────────────┬────────────────────┐
  │ COMPONENT             │ PRIMITIVE          │
  ├───────────────────────┼────────────────────┤
  │ AEAD cipher           │ XChaCha20-Poly1305 │
  │ key derivation        │ HKDF-SHA-256       │
  │ key encapsulation     │ ML-KEM-768         │
  │ signatures            │ Ed25519            │
  │ fingerprint           │ BLAKE3             │
  │ transparency chain    │ SHA-256 Merkle     │
  │ group model           │ sender keys, O(N)  │
  │ forward secrecy + PCS │ sparse PQ ratchet  │
  │ protocol format       │ 0xNN               │
  └───────────────────────┴────────────────────┘

tab order: copyBtn → downloadBtn → cancelBtn
the QR and table are inert (not focusable). Cancel returns to Landing.
```

**crypto table:** rows come from `CRYPTO_TABLE`
([LIB-SPEC § protocol manifest](./LIB-SPEC.md#protocol-manifest)), the same
array the web client's definition list maps over
([WEB-SPEC § waiting](./WEB-SPEC.md#waiting)), so the two cannot drift.
the cipher name, KEM name, and the `protocol format` byte derive from the
`PROTOCOL` manifest; the rest are curated strings. the format byte is covcom's
own wire-protocol version (`PROTOCOL_VERSION`), a hand-bumped integer kept
deliberately separate from the cipher suite. inner column widths are 23 (label)
and 20 (value), sized to the longest entries. the box-drawing characters here are
the only ones in the app, per the goals above. see [PROTOCOL](./PROTOCOL.md) for
the versioning system.

**QR code:** a scannable QR of the same armored invite, encoded by the shared
`qrMatrix` ([LIB-SPEC § qr](./LIB-SPEC.md#qr)) and rendered by `qrHalfBlock`
(`tui/qr.ts`), which
packs two module rows per text row with half-block glyphs and adds a quiet zone.
it renders forced black-on-white regardless of theme for scanner contrast. it
sits one blank row above the table, and the whole centered block recomputes to
include it. it is omitted when the invite is too large to encode (the web client omits its
QR pane the same way; see [WEB-SPEC § waiting](./WEB-SPEC.md#waiting)) or when it
would not fit the terminal, falling back to the table-only layout.

Example:
```

 █▀▀▀▀▀█ █▀ █▀ █▄  ▀▄▀███▄ █ █ █ ▀▀ ▄▀ █▀▀▀▀▀█
 █ ███ █ █▄▄ ▄▄▀▀█  ▀▄ █  █▀█▄███▀█ █▄ █ ███ █
 █ ▀▀▀ █ ▄▀█ ▀▀ █▄▀▀▄█▀▀▀██▀█▄▀▀▄▀█▀▀▀ █ ▀▀▀ █
 ▀▀▀▀▀▀▀ ▀ █ █ █ █ ▀ █ ▀ █ ▀▄▀▄█ █▄▀▄▀ ▀▀▀▀▀▀▀
 ██ ▄█▀▀ ▄▀▀  ▄▄▄▄██ ▀▀█▀█▄██ ▄▄▀██ ▄█ ▄▀ ███▀
   ▀ █▄▀█ ▄███▀▀▀ ███ ▀█ ▄███ ▀ █████   ▀▀▀▀▄
  ▄▄█▄▀▀▄▀ █ █▄██ ▀█▀ █ ▄█▄█ ▄▄█▀▀▄▀█▄ ██▄▄  ▄
  ▀▄ ▀█▀▄███▀ ▄ ▀ ▄ ▄ ▀▄▄▄ ▀▀▄█ ▀▄  ██ ▀▄▀▄ █
 ▄▀▀▀▄ ▀ ▄█▀█ ▀█  ▀█ ▀ ▄ █▀█▀ ██▀█▄▀ ▄ ▄ ▄▄ ▄▀
  █▄▀▀ ▀ █  ▄ ███ ▄ ▄  █▄ ▄▄██  ▀▀▄▀ ▄▄▄   ▀▄
 ▄▀█▀█▀▀▀██▄ ▀ █▄ ▀▀▄█▀▀▀█▄█▄▄▄█ █▄  █▀▀▀██▀▄▄
 ▄▄▀▄█ ▀ █▀█▀█▀█ █  ▄█ ▀ █▄█▀▀▀▀ ▄ ▄██ ▀ █  ▀
 ▄▄█▀▀▀▀▀▀▀▄▀█▄▄   ▀▀▀█▀▀█▀▄▄ █▄▀█▄▀▀▀█▀▀▀ ██▀
  ▄ ▄█ ▀▄▄▄█▄ ▀  ▀▄  ▀▀▀▄▀▄█▀▀ ▄▀█▀██▄▀▄ ██▀▄
 ▀█████▀█▄▀ ▄█▄█▀▀▀▀▄▀▀ █▀ █▄ █▄ ▀▄▀▄   ▄  ▄
   ▄▄▄▀▀ ▄█▀██▄  ▄ ▀  ▄██▀ ▄ ▄▄▀ ▄▄▀ ▀█ ▄▀▀▀▀
 ▄█▄█▀▄▀ ▀▄▀▄▀▀█ ▀ ▀█ █ ▄█▀▄▀▄▄▄▀██ ▄▄▀▄▄▀ ▀█
  ▄▄▄█ ▀▄▄▄▀▀█ ▄ ▀ ▀ ▀  ▀ ▄ █▄████▄▀█▄▀▄▀█ ▀
 ▀  ▀▀ ▀ █▄▀▄█▄▀▄▀▀███▀▀▀█ █▀▄▄█▄▀▀ ▄█▀▀▀█▄▄▀█
 █▀▀▀▀▀█ ▄▄██▄▀█▀█ ▀▀█ ▀ █ ▄█ █▄▀▄ ▄▄█ ▀ █  █
 █ ███ █ ▀▄ ▀█▄▄ ▀ ▀▀██▀█▀ █▀▄██▀█▄ ▄▀▀█▀▀ ▀ █
 █ ▀▀▀ █ ▄ █▄  █ ▀ ████▀▄ ██▀  ▄▀ ██▄▄▄▀ ▀   ▀
 ▀▀▀▀▀▀▀ ▀▀    ▀▀ ▀▀▀▀▀ ▀▀▀ ▀ ▀▀ ▀ ▀  ▀▀▀    ▀

```

**copy / download feedback:** both actions report through the shared modal layer,
not an inline callout.

- copy: a `Copied` modal on success, a `Copy Failed` modal with the error accent
  when no clipboard binary is found.
- download: writes `inviteFilename(roomId)` (`covcom-<roomId>.room`) to
  `process.cwd()`, using `resolveUniqueFilename` (`cli/src/util.ts`) to avoid
  clobbering an existing file, then shows an `Invite Downloaded` modal with the
  full resolved path.

**copy behavior:**
- checks config `copyCmd` first (user-supplied binary + flags, e.g. `"xsel -b"`)
- if not set, probes for known bins in order: `pbcopy`, `xclip -selection clipboard`,
  `xsel -b`, `wl-copy`
- spawns each in turn, piping the armored invite to stdin, and stops at the first
  that exits 0
- if none succeed, shows the `Copy Failed` modal

### `renderChat`

```
layout (sidebar closed, full screen):
  msgArea   [ScrollView]  @ (1, 1)              w=screen.w   h=screen.h-3
  separator                                      1 row of barBg fill
  chatInput [TextInput]   @ (2, screen.h-1)     w=inputW
  sendBtn   [Button]      @ (xSend, ...)        w=cellW(send)+2     default label ">"
  attachBtn [Button]      @ (xAttach, ...)      w=cellW(attach)+2   default label "+"
  rotateBtn [Button]      @ (xRatchet, ...)     w=cellW(ratchet)+2  default label "R"

  positions are derived right-to-left from the right edge:
    xRatchet = chatW - cellW(ratchet) - 2
    xAttach  = xRatchet - cellW(attach) - 2
    xSend    = xAttach - cellW(send) - 2
    inputW   = max(1, xSend - 3)   // leaves a 1-col gap before sendBtn

  labels come from `config.icons` (see [configuration](./USAGE.md#configuration)); cellW counts
  unicode codepoints so Nerd Font glyphs in supplementary plane render
  in a single cell.

layout (sidebar open, screen.w >= 80):
  sideW = floor(screen.w * sidebar.width / 100), clamped to [10, screen.w-24]
  chatW = screen.w - sideW - 1
  msgArea / separator / input bar use chatW instead of screen.w
  vertical separator column @ x=chatW+1 (1 col, full height, barBg)
  sidebar   [Sidebar]    @ (chatW+2, 1)         w=sideW   h=screen.h

layout (sidebar open, screen.w < 80):
  sidebar   [Sidebar]    @ (1, 1)               w=screen.w   h=screen.h
  chat is not drawn; the sidebar owns the whole screen

tab order: chatInput → sendBtn → attachBtn → rotateBtn → msgArea → sidebar
  (sidebar is registered only when the sidebar is open; when full-width the ring
  holds only the sidebar and Tab closes it back to the chat)
```

**chat input special behavior:**
- enter → sends message (calls send action), does not Tab to next widget
- Tab → normal focus cycle
- Esc → opens the modal keys-display (see above), gated on chatInput focus
- a value starting with `/` is dispatched as a slash command instead of
  being sent. recognized commands: `/exit` (`/quit`, `/q`, `/part`) quit,
  `/ratchet` rotate keys, `/events` toggle event log, `/verify` toggle verify
  pane, `/help` (`/?`) print the list. unknown slash inputs surface a system
  message; the text is not transmitted. the web client accepts the identical
  command set ([WEB-SPEC § chat](./WEB-SPEC.md#chat)).

**scrollView focus:**
- when msgArea is focused, up/down/pgup/pgdn scroll the chat
- mouse wheel over msgArea scrolls regardless of focus

**sidebar toggles:**
- the keys-display (`E`/`V`) and the `/events` / `/verify` commands toggle the
  event-log and verify modes
- when sidebar is open, focus jumps to it; closing returns focus to chatInput
- see the `Sidebar` widget section above for in-pane bindings

**FilePicker mode (attach):**
- attachBtn.onClick() → renderChat enters `picking` state
- the input bar is replaced with the attach icon, a path `TextInput`, and a
  `cancelBtn` (`x`); the normal input and send/ratchet buttons are hidden
- the path input carries tab-completion (see the FilePicker widget section)
- enter → validates the path, calls the upload handler, exits picking state
- esc → cancels, exits picking state
- sidebar stays rendered (its toggles still work) but is unfocusable while
  picking; the focus ring is reduced to `pathInput → cancelBtn`

**attachments in chat (select, download, open):**
- the buffer drives selection: with focus on msgArea, up/down move the selected
  attachment and Enter downloads it (calls the file's `download` callback)
- a click on an attachment chip focuses msgArea; once a file has been saved,
  clicking its chip opens it with the OS opener (`open` on macOS, `xdg-open`
  elsewhere)

**file download flow:**
- the `download` callback (supplied by state.ts) decrypts the file payload,
  resolves a non-colliding path in `process.cwd()` via `resolveUniqueFilename`
  (existing filenames receive a `_1`, `_2`, … suffix), writes the plaintext via
  `Bun.write`, and returns the saved path
- on success: `ScrollView.markSaved` records the path on the message so the chip
  becomes openable, state.ts renders a `File Downloaded` modal, and an event-log
  entry is appended with `direction: 'in'`, `kind: 'file'`
- on failure: a system message is appended to the chat scroll with the resolved
  path and the error reason; no modal renders

---

## color system

### theme type

```ts
type ColorValue =
  | { type: 'ansi16'; n: number }     // 0-15, basic ANSI targeting
  | { type: '256';    n: number }     // 0-255
  | { type: 'hex';    value: string } // '#rrggbb'
  | null                              // inherit terminal default (bg/fg only)

type Theme = {
  bg:            ColorValue   // null = inherit
  fg:            ColorValue   // null = inherit

  inputBg:       ColorValue
  inputFg:       ColorValue

  btnBg:         ColorValue
  btnFg:         ColorValue
  btnFocusBg:    ColorValue
  btnFocusFg:    ColorValue
  btnDisabledBg: ColorValue
  btnDisabledFg: ColorValue

  barBg:         ColorValue
  barFg:         ColorValue
  barBtnBg:      ColorValue
  barBtnFg:      ColorValue
  barBtnFocusBg: ColorValue
  barBtnFocusFg: ColorValue

  yourMsg:       ColorValue
  peer0:         ColorValue   // self (reserved)
  peer1:         ColorValue
  peer2:         ColorValue
  peer3:         ColorValue
  peer4:         ColorValue
  peer5:         ColorValue
  peer6:         ColorValue
  peer7:         ColorValue
  peerMsg:       ColorValue

  attachBg:         ColorValue
  attachFg:         ColorValue
  attachSelectedBg: ColorValue
  attachSelectedFg: ColorValue
  barAttach:        ColorValue

  calloutBg:     ColorValue
  calloutFg:     ColorValue

  modalBg:       ColorValue
  modalFg:       ColorValue
  modalBorder:   ColorValue
  modalTitle:    ColorValue

  disabled:      ColorValue
  system:        ColorValue
  error:         ColorValue

  evtTime:        ColorValue
  evtArrow:       ColorValue
  evtMsg:         ColorValue
  evtKey:         ColorValue
  evtVal:         ColorValue
  evtSelf:        ColorValue
  evtPeer:        ColorValue
  evtKindDefault: ColorValue
  evtKindError:   ColorValue
  evtKindMember:  ColorValue
  evtKindRatchet: ColorValue

  codeFg:        ColorValue
  codeBg:        ColorValue

  keyFg:         ColorValue
  ratchetTxtFg:  ColorValue
}
```

### defaults

```ts
const defaultTheme: Theme = {
  bg:            null,
  fg:            null,

  inputBg:       { type: 'ansi16', n: 0  },   // black
  inputFg:       { type: 'ansi16', n: 15 },   // bright white

  btnBg:         { type: 'ansi16', n: 8  },   // dark gray
  btnFg:         { type: 'ansi16', n: 15 },   // bright white
  btnFocusBg:    { type: 'ansi16', n: 4  },   // blue
  btnFocusFg:    { type: 'ansi16', n: 15 },   // bright white
  btnDisabledBg: { type: 'ansi16', n: 8  },   // dark gray
  btnDisabledFg: { type: 'ansi16', n: 8  },   // dark gray (invisible label)

  barBg:         { type: 'ansi16', n: 8  },   // dark gray
  barFg:         { type: 'ansi16', n: 15 },   // bright white
  barBtnBg:      { type: 'ansi16', n: 8  },   // dark gray (mirrors btnBg)
  barBtnFg:      { type: 'ansi16', n: 15 },   // bright white (mirrors btnFg)
  barBtnFocusBg: { type: 'ansi16', n: 4  },   // blue (mirrors btnFocusBg)
  barBtnFocusFg: { type: 'ansi16', n: 15 },   // bright white (mirrors btnFocusFg)

  yourMsg:       { type: 'ansi16', n: 7  },   // white (muted)
  peer0:         { type: 'ansi16', n: 10 },   // bright green (self)
  peer1:         { type: 'ansi16', n: 14 },   // bright cyan
  peer2:         { type: 'ansi16', n: 12 },   // bright blue
  peer3:         { type: 'ansi16', n: 13 },   // bright magenta
  peer4:         { type: 'ansi16', n: 11 },   // bright yellow
  peer5:         { type: 'ansi16', n: 9  },   // bright red
  peer6:         { type: 'ansi16', n: 5  },   // magenta
  peer7:         { type: 'ansi16', n: 2  },   // green
  peerMsg:       { type: 'ansi16', n: 15 },   // bright white

  attachBg:         { type: 'ansi16', n: 6 },   // cyan
  attachFg:         { type: 'ansi16', n: 0 },   // black
  attachSelectedBg: { type: 'ansi16', n: 2 },   // green
  attachSelectedFg: { type: 'ansi16', n: 0 },   // black
  barAttach:        { type: 'ansi16', n: 6 },   // cyan (mirrors attachBg)

  calloutBg:     { type: 'ansi16', n: 3  },   // yellow
  calloutFg:     { type: 'ansi16', n: 0  },   // black

  modalBg:       { type: 'ansi16', n: 0  },   // black
  modalFg:       { type: 'ansi16', n: 15 },   // bright white
  modalBorder:   { type: 'ansi16', n: 6  },   // cyan
  modalTitle:    { type: 'ansi16', n: 14 },   // bright cyan

  disabled:      { type: 'ansi16', n: 8  },   // dark gray
  system:        { type: '256',    n: 250 }, // light gray
  error:         { type: 'ansi16', n: 9  },   // bright red

  evtTime:        { type: 'ansi16', n: 8  },  // dark gray
  evtArrow:       { type: 'ansi16', n: 15 },  // bright white
  evtMsg:         { type: 'ansi16', n: 15 },  // bright white
  evtKey:         { type: 'ansi16', n: 8  },  // dark gray
  evtVal:         { type: 'ansi16', n: 15 },  // bright white
  evtSelf:        { type: 'ansi16', n: 5  },  // magenta
  evtPeer:        { type: 'ansi16', n: 6  },  // cyan
  evtKindDefault: { type: 'ansi16', n: 4  },  // blue
  evtKindError:   { type: 'ansi16', n: 1  },  // red
  evtKindMember:  { type: 'ansi16', n: 2  },  // green
  evtKindRatchet: { type: 'ansi16', n: 3  },  // yellow

  codeFg:        { type: 'ansi16', n: 15 },   // bright white
  codeBg:        { type: 'ansi16', n: 8  },   // dark gray

  keyFg:         { type: 'ansi16', n: 3  },   // yellow
  ratchetTxtFg:  { type: 'ansi16', n: 8  },   // dark gray
}
```

### config extension

see [configuration](./USAGE.md#configuration) for the canonical list of every
field, every theme slot, and an example file. the theme loader runs at startup as
`const theme = { ...defaultTheme, ...config.theme }`, so any subset of
slots can be overridden without restating the defaults.

---

## render cycle

purely event-driven. no setInterval. no polling.

```
stdin data
  └─ parse InputEvent
       ├─ key/paste → view.onInput()
       │    └─ widget.onKey() / widget.onPaste()
       │         └─ screen.markDirty() on state change
       └─ mouse
            ├─ click → hit test → focus + onClick()
            │    └─ screen.markDirty()
            └─ scroll → route to scrollView if in bounds
                 └─ screen.markDirty()

after any input:
  if screen.needsRender():
    screen.beginRender()
    screen.clear()
    view.render(screen)
    screen.endRender()

incoming websocket message:
  scrollView.addMessage(msg)
  screen.markDirty()
  if screen.needsRender():
    screen.beginRender()
    screen.clear()
    view.render(screen)
    screen.endRender()
```

render always starts with `screen.hideCursor()`. after all widgets are drawn,
if the focused widget is a text input, `screen.showCursor(cursorX, cursorY)` is
called with the computed cursor position of that input. no other widget shows a cursor.

---

## exit and teardown

every way the app can quit routes through one teardown. `main.ts` registers
`SIGINT`, `SIGTERM`, and `exit` handlers that all call `doCleanup()` from
`lifecycle.ts`. the fatal-error catch and its `process.exit(1)` reach the same
place through the `exit` event. the `/exit` family (`/quit`, `/q`, `/part`) emits
`SIGINT` rather than exiting on its own, so it lands on that single path too.
ctrl+c is guarded: the first press arms a `quit covcom?` confirm modal and the
second press emits `SIGINT`, so an accidental ctrl+c does not drop the session.

`state.ts` registers the one cleanup function in `mount()`, before any view
renders. it reads the module-level `current` phase, so it covers landing, join,
waiting, and chat without re-registering per phase. the cleanup runs in order:

1. **mark shutdown:** sets a `_shuttingDown` flag so the intentional
   `ws.close()` below does not trip the reconnect path and print a spurious
   "Connection lost. Reconnecting" notice on the way out.
2. **wipe crypto state:** disposes all inbound receivers, and when a session
   exists (the `waiting` or `ready` phase) disposes the session and closes the
   socket.
3. **restore the terminal:** calls `screen.destroy()`, which leaves the
   alternate buffer, re-shows the cursor, disables mouse and bracketed-paste
   reporting, and drops raw mode.

leaving the alternate buffer restores whatever filled the screen before covcom
launched, so the exit is clean with no leftover frame and the user's scrollback
stays intact. a full `\x1bc` reset is deliberately avoided because it would also
wipe that scrollback. the web client's analogue is its `beforeunload` teardown;
see [WEB-SPEC § key hygiene](./WEB-SPEC.md#key-hygiene).

> [!IMPORTANT]
> Every exit call site must funnel through this path. Do not call
> `process.exit()` directly from a view, widget, or event handler, and do not
> tear the terminal down inline. Emit `SIGINT` (ctrl+c and the `/exit` family
> already do this) or let the error propagate to the `exit` handler. A direct
> exit skips the crypto wipe and the terminal restore, leaving key material in
> memory and the shell stuck in the alternate buffer with raw mode still on.

---

## open / deferred

- **word wrap:** split on spaces, accumulate until the line exceeds the width,
  break. width is measured in display columns via a pragmatic wcwidth, so wide
  CJK and emoji count as two columns and combining marks as zero. a word wider
  than the pane is hard-split on code-point boundaries, never mid-surrogate.
  multi-code-point ZWJ grapheme clusters (e.g. family emoji) still over-count
  their parts; terminals disagree on those anyway.
- **tab completion UX:** the FilePicker ships the simple cycle (each Tab advances
  to the next match). bash-style longest-common-prefix completion is still
  deferred.
- **resize handling:** SIGWINCH → `screen.measure()` → `screen.markDirty()`.
  views recompute layout from `screen.w/h` on every render so resize is free.
- **mouse in tmux over ssh:** mouse events work but the user cannot hold shift to
  select text with the terminal's native selection while mouse mode is on.
  consider a toggle (e.g. ctrl+m) to disable/re-enable mouse reporting.

---

## Cross Reference

| Document | Description |
| -------- | ----------- |
| [index](./README.md) | Project Documentation index |
| [USAGE](./USAGE.md) | Client and server applications development and runtime help |
| [PROTOCOL](./PROTOCOL.md) | Cipher, chains, ratchet, group model, session lifecycle, server role |
| [CRYPTOGRAPHY](./CRYPTOGRAPHY.md) | Primitives, KDF chains, wire format, invite encoding |
| [THREAT-MODEL](./THREAT-MODEL.md) | Principals, adversary tiers, guarantees, non-goals |
| [LIB-SPEC](./LIB-SPEC.md) | Shared library API, session and identity surface, invites, file transfer, and protocol manifest |
| [SERVER-SPEC](./SERVER-SPEC.md) | Server wire contract, message handlers, room lifecycle, and configuration |
| [WEB-SPEC](./WEB-SPEC.md) | Web client architecture, state and session model, views, rendering, and the single-file build |
| [TESTING](./TESTING.md) | Test layers, unit and end-to-end suites, cross-client interop, and CI |
