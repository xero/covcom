```
  ▄██▀ ▀█  ▄██▀ █▄  ▀██  ██▀  ▄██▀ ▀█  ▄██▀ █▄   █▄   ▄█
 ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒  ▒▒  ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒▒▄▒▒▒
 ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒▌ ▒▒  ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒ ▀ ▒▒
  ▀██▄ ▄█  ▀██▄ █▀    ▀█▄▀    ▀██▄ ▄█  ▀██▄ █▀  ▄██▄ ▄██▄

XChaCha20 · ML-KEM-768 · SPQR · E2EE · ephemeral · N-party
```

# COVCOM CLI TUI Design Spec

cli app design doc. covers architecture, rendering, input, widgets, views, and color system.

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
├── screen.ts     terminal primitives, alternate buffer, cursor, fill, ANSI helpers
├── keys.ts       raw keypress + mouse event parser
├── focus.ts      focus ring, tab/shift-tab cycling, direct set-by-id
├── widgets.ts    TextInput, TextArea, Button, ScrollView, FilePicker
└── views.ts      LoginView, WaitingView, JoinView, ChatView
```

app entrypoint creates a `Screen`, initializes the first view, enters the event loop.
view transitions are just swapping which view handles render and input:

```
LoginView → WaitingView   (create room)
LoginView → JoinView      (join room)
WaitingView → ChatView    (peer connected)
JoinView → ChatView       (connect successful)
```

---

## screen

one instance for the app lifetime. owns the terminal.

```ts
class Screen {
  w: number   // columns
  h: number   // rows
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
    this.w = process.stdout.columns
    this.h = process.stdout.rows
  }

  moveTo(x: number, y: number) {
    process.stdout.write(`\x1b[${y};${x}H`)
  }

  // fill a rectangle with a bg color. used for all widget backgrounds.
  fillRect(x: number, y: number, w: number, h: number, bg: number | null) {
    const bgSeq = bg !== null ? ansi.bg(bg) : ''
    const row = ' '.repeat(w)
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
  reset: '\x1b[0m',
  bold:  '\x1b[1m',
  dim:   '\x1b[2m',

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
- arrow keys (`\x1b[A/B/C/D`)
- shift+tab (`\x1b[Z`)
- home/end (`\x1b[H`, `\x1b[F`, `\x1b[1~`, `\x1b[4~`)
- pageup/pagedown (`\x1b[5~`, `\x1b[6~`)
- enter (`\r`, `\n`), tab (`\t`), backspace (`\x7f`, `\x08`), escape (`\x1b`)
- ctrl+letter (bytes 0x01-0x1a)
- bracketed paste: `\x1b[200~` ... `\x1b[201~` → emitted as a single `paste` event
  with the full pasted string, never parsed as individual keystrokes
- printable chars

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
this is what makes hit testing work — after every render pass, every widget's
`rect` reflects where it currently lives on screen.

### `TextInput`

single-line. tracks value + cursor position.

- renders as `fillRect` with `inputBg`, then writes value text in `inputFg`
- cursor shown as the character at cursor position rendered with inverted colors,
  or a space if at end of string
- backspace, left/right arrows, home/end, ctrl+a/e, ctrl+k (clear to end),
  ctrl+u (clear to start) all handled
- enter: does not consume — propagates to view to trigger form action
- paste: inserts pasted text at cursor position

### `TextArea`

multiline. used for the invite paste box in JoinView and the attach FilePicker.

- same as TextInput but enter inserts `\n` instead of propagating
- tracks lines + vertical scroll offset
- up/down arrows move between lines
- paste works naturally (bun delivers pasted text as single data event)

### `Button`

```ts
class Button implements Widget {
  id:       string
  label:    string
  rect:     Rect = { x:0, y:0, w:0, h:0 }
  disabled: boolean = false
  action:   () => void

  render(scr: Screen, rect: Rect, focused: boolean, theme: Theme) {
    this.rect = rect
    const bg = this.disabled ? theme.btnDisabledBg
             : focused       ? theme.btnFocusBg
             :                 theme.btnBg
    const fg = this.disabled ? theme.btnDisabledFg
             : focused       ? theme.btnFocusFg
             :                 theme.btnFg
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

disabled buttons render with `btnDisabledFg === btnDisabledBg` — label invisible,
just a gray slab. clearly inert.

### `ScrollView`

chat message display. tracks a buffer of pre-rendered lines.

```ts
type ChatLine = {
  text:        string
  isSelf:      boolean
  attachment?: { filename: string; id: string }
}

type RenderedLine = {
  bufferIdx:   number       // index in this.lines[]
  screenY:     number       // row this line was drawn at during last render
  attachment?: { filename: string; id: string }
}
```

key behaviors:

- new messages appended to `lines[]`, word-wrapped to current width
- `autoScroll = true` by default — new messages scroll to bottom
- scrolling up (keyboard or mouse wheel) disables autoScroll
- scrolling back to bottom re-enables autoScroll
- during render, fills each visible row with spaces at default bg (terminal inherits),
  writes line content. populates `renderedLines[]` as it goes.
- scroll indicator: single `█` on the right edge, positioned proportionally

**attachment chip rendering:**

```
  yourName: ┤ filename.ext ├
```

actually simpler — just an inline color change mid-line:

```
  yourName:  filename.ext
            ^            ^
         attachBg      reset
```

rendered as part of the line text with ANSI color wrapping. `renderedLines[]`
records the screen row and attachment metadata so hit testing can find it.

**hit testing:**

```ts
hitTest(x: number, y: number): { attachment: Attachment } | null {
  for (const rl of this.renderedLines) {
    if (rl.screenY === y && rl.attachment) {
      // check if x falls within the chip's column range
      // chip range is also stored in RenderedLine during render
      return { attachment: rl.attachment }
    }
  }
  return null
}
```

**keyboard:** up/down scroll by 1, pgup/pgdn by 10. view routes these to scrollView
only when scrollView is focused.

**mouse wheel:** scroll events whose `(x, y)` falls inside `scrollView.rect` always
route to scrollView regardless of focus.

### `FilePicker`

takes over the chat bar area when the `+` button is activated. not a standalone
widget so much as a mode the ChatView enters.

visual: replaces `[input] [>] [+]` with `[path input] [x]`

the path input is a `TextInput` with tab-completion behavior layered on top:

- on Tab keypress, reads the current value up to the last `/`, calls `fs.readdirSync`
  on that directory (or cwd if no `/`), filters entries by the typed prefix
- first Tab: complete to longest common prefix of matches
- subsequent Tabs on same prefix: cycle through matches
- Esc: cancel, restore normal bar
- Enter: confirm path, exit FilePicker mode, trigger upload callback

no file tree. no GUI. just a text input that knows about the filesystem.

---

## views

each view:
- owns a `FocusRing`
- owns a flat array of `Widget[]` (everything registered for hit testing)
- computes layout from `screen.w` / `screen.h` on each render
- delegates `InputEvent` to focused widget first, then handles globally (tab, etc.)

```ts
interface View {
  render(scr: Screen): void
  onInput(ev: InputEvent, scr: Screen): void
}
```

### `LoginView`

```
layout (centered on screen):
  content width  = min(screen.w - 8, 44)
  content height = 14
  origin x       = Math.floor((screen.w - contentW) / 2)
  origin y       = Math.floor((screen.h - contentH) / 2)

  label "Server DNS:"           @ (ox, oy)
  serverInput    [TextInput]    @ (ox, oy+1)      h=1
  label "Username:"             @ (ox, oy+3)
  usernameInput  [TextInput]    @ (ox, oy+4)      h=1
  label "Auth Token (optional)" @ (ox, oy+6)
  tokenInput     [TextInput]    @ (ox, oy+7)      h=1
  createBtn      [Button]       @ (ox, oy+10)     w=14 h=1
  joinBtn        [Button]       @ (ox+16, oy+10)  w=12 h=1

tab order: serverInput → usernameInput → tokenInput → createBtn → joinBtn
```

enter on any input: focuses next input (same as Tab), or triggers action if on last.

### `JoinView`

```
layout (centered, slightly taller):
  pathInput      [TextInput]    file path
  loadBtn        [Button]       loads .room file
  inviteArea     [TextArea]     paste invite block. multiline.
  parseBtn       [Button]       parses invite text from inviteArea
  connectBtn     [Button]       disabled until a room is parsed/loaded
  statusLine                    plain text: "Server: ... / Room: ..."

tab order: pathInput → loadBtn → inviteArea → parseBtn → connectBtn

connectBtn.disabled = true until either:
  - loadBtn successfully reads a .room file, or
  - parseBtn successfully parses a valid room from inviteArea
```

### `WaitingView`

shown after create room succeeds. receives `armoredInvite` string and `roomId`.
transitions automatically to ChatView when peer connects (driven by state.ts).

```
layout (centered on screen):
  content width = min(screen.w - 8, 52)
  origin x      = Math.floor((screen.w - contentW) / 2)
  origin y      = Math.floor((screen.h - contentH) / 2)

  heading "Room Code Generated Successfully"   @ (ox, oy)     fg=fg
  subhead "Waiting for peer(s) to connect"     @ (ox, oy+1)   fg=disabled

  copyBtn        [Button]   @ (ox, oy+3)        w=14  label="Copy Code"
  downloadBtn    [Button]   @ (ox+16, oy+3)     w=14  label="Download"

  callout        [Callout]  @ (ox, oy+5)        conditionally rendered (see below)

  table                     @ (ox, oy+7) or (ox, oy+5) if no callout
    ┌────────┬───────────────────────┐
    │ cipher │  XChaCha20-Poly1305   │
    │ kem    │  ML-KEM-768           │
    │ format │  0x01                 │
    └────────┴───────────────────────┘

tab order: copyBtn → downloadBtn
table is inert (not focusable).
```

**callout states:**

the callout region renders one of three states. on first load it is empty (no
callout rendered, table moves up by 2 rows). each button action replaces whatever
callout was previously showing. only one callout is ever visible at a time.

```
copy success:
  [Code copied to your clipboard]
  bg=calloutBg, fg=calloutFg

copy failure:
  [Failed to find a clipboard manager]
  bg=calloutBg, fg=calloutFg    (same color — content communicates state)

download success (path wraps continuously, no truncation):
  [file downloaded to:          ]
  [/full/path/to/roomId.room    ]
  [ ...continues if path long   ]
  bg=calloutBg, fg=calloutFg
```

the callout is rendered as filled rows of width `contentW`. each row is padded
with spaces to fill the full width. path lines wrap purely by character count —
no ellipsis, no truncation. tmux users can select the path directly.

**download behavior:**
- writes `<inviteFilename()>.room` to `process.cwd()`
- uses `resolveUniqueFilename` (already in `cli/src/util.ts`) if the file exists
- shows the full absolute resolved path in the callout

**copy behavior:**
- checks config `copyCmd` first (user-supplied binary + flags, e.g. `"xsel -b"`)
- if not set, probes for known bins in order: `pbcopy`, `xclip -selection clipboard`,
  `xsel -b`, `wl-copy`
- spawns the found command, pipes the armored invite to stdin
- on failure to find any bin: renders the failure callout
- on spawn error: renders failure callout with the error reason if short enough,
  otherwise generic message

### `ChatView`

```
layout (full screen):
  msgArea   [ScrollView]  @ (1, 1)              w=screen.w   h=screen.h-3
  separator                                      1 row of barBg fill
  chatInput [TextInput]   @ (2, screen.h-1)     w=screen.w-12
  sendBtn   [Button]      @ (screen.w-9, ...)   w=5   label=">"
  attachBtn [Button]      @ (screen.w-3, ...)   w=3   label="+"

tab order: chatInput → sendBtn → attachBtn → msgArea
```

**chat input special behavior:**
- enter → sends message (calls send action), does not Tab to next widget
- Tab → normal focus cycle

**scrollView focus:**
- when msgArea is focused, up/down/pgup/pgdn scroll the chat
- mouse wheel over msgArea scrolls regardless of focus

**FilePicker mode (attach):**
- attachBtn.onClick() → ChatView enters `picking` state
- chatInput hidden, sendBtn hidden, attachBtn replaced with `cancelBtn`
- `pathInput [TextInput]` takes chatInput's rect, with tab-completion active
- enter → confirms path, calls upload handler, exits picking state
- esc → cancels, exits picking state

**attach click in chat:**
- mouse click on an attachment chip → calls download handler for that attachment id
- no focus change, no keyboard equivalent needed for this action

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

  yourName:      ColorValue
  yourMsg:       ColorValue
  peerName:      ColorValue
  peerMsg:       ColorValue

  attachBg:      ColorValue
  attachFg:      ColorValue

  calloutBg:     ColorValue
  calloutFg:     ColorValue

  disabled:      ColorValue
  error:         ColorValue
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

  yourName:      { type: 'ansi16', n: 14 },   // bright cyan
  yourMsg:       { type: 'ansi16', n: 7  },   // white (muted)
  peerName:      { type: 'ansi16', n: 10 },   // bright green
  peerMsg:       { type: 'ansi16', n: 15 },   // bright white

  attachBg:      { type: 'ansi16', n: 6  },   // cyan
  attachFg:      { type: 'ansi16', n: 15 },   // bright white

  calloutBg:     { type: 'ansi16', n: 3  },   // yellow
  calloutFg:     { type: 'ansi16', n: 0  },   // black

  disabled:      { type: 'ansi16', n: 8  },   // dark gray
  error:         { type: 'ansi16', n: 9  },   // bright red
}
```

### config extension

`cli/src/config.ts` `Config` interface gains two new optional fields:

```ts
interface Config {
  server?:    string
  username?:  string
  authToken?: string
  copyCmd?:   string          // e.g. "xsel -b", "xclip -selection clipboard"
  theme?:     Partial<Theme>  // any subset of Theme slots
}
```

the theme loader runs at startup: `const theme = { ...defaultTheme, ...config.theme }`.

example `~/.config/covcom/config.json`:

```json
{
  "server": "chat.example.com",
  "username": "xero",
  "copyCmd": "xsel -b",
  "theme": {
    "btnFocusBg":  { "type": "256",    "n": 33          },
    "yourName":    { "type": "hex",    "value": "#ff8800" },
    "peerName":    { "type": "ansi16", "n": 13           }
  }
}
```

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

## open / deferred

- **word wrap:** split on spaces, accumulate until line exceeds width, break.
  unicode grapheme clusters punted for now.
- **tab completion UX:** implement simple cycle first (each Tab advances to next match),
  revisit bash-style longest-common-prefix later once it's usable.
- **resize handling:** SIGWINCH → `screen.measure()` → `screen.markDirty()`.
  views recompute layout from `screen.w/h` on every render so resize is free.
- **ctrl+c vs alt buffer:** `screen.destroy()` must fire on ctrl+c, unhandled
  exceptions, and SIGTERM to ensure the terminal is always restored cleanly.
- **mouse in tmux over ssh:** mouse events work but the user cannot hold shift to
  select text with the terminal's native selection while mouse mode is on.
  consider a toggle (e.g. ctrl+m) to disable/re-enable mouse reporting.
- **QR code:** v2. WaitingView layout should leave space below the table for it.
  implementation: pure-TS QR matrix generator rendered with unicode half-blocks.
