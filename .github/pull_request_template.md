## Description
<!--
REQUIRED — this section becomes the "What's New" block in the GitHub Release notes.
Write user-facing bullets (not implementation details). Markdown OK.

Delete this comment and the example below, then write your real content.

Example:
- Server can now use OIDC for login (set CC_OIDC_ISSUER)
- Fixed crash when right-clicking the tray icon during shutdown
- Faster cold-start on Windows
-->

_Replace this line with your release notes._

## PR title format (required — enforced by CI)

`<group>[+<group>...]: <description>`

where each `<group>` is `<type>[!](<scope>[,<scope>...])`.

### Type → bump

| Type                                                       | Bump  | Release? |
|------------------------------------------------------------|-------|----------|
| `feat!` / `fix!` / `<type>!`                               | major | yes      |
| `feat`                                                     | minor | yes      |
| `fix`, `perf`                                              | patch | yes      |
| `docs`, `chore`, `refactor`, `test`, `ci`, `build`, `style`| none  | **no**   |

### Scope → platform (required for feat/fix/perf)

`windows` · `macos` · `linux-gui` · `linux-cli` · `linux`\* · `android` · `server` · `desktop`\* · `all`

\* `linux` = both Linux variants. `desktop` = windows + macos + both linux.
Linux GUI and CLI are tracked separately for versioning but share one package artifact.

### Mixed bumps

Join groups with `+` to describe different types of changes:
- `feat(server)+fix(windows): backend rewrite + tray crash`
- `feat!(android)+feat(server)+fix(desktop): rework crypto`

The highest bump across all groups advances the global release version
(`major` > `minor` > `patch`). Every selected platform adopts that version;
unselected platforms keep their existing versions and packages.

### Rules
- A scope may appear in **only one** group across the title.
- Releasing and non-releasing types **cannot** be mixed.
- Non-releasing types take no scope.

### Examples
- `feat(server): add OIDC login`
- `fix(windows,macos): clipboard race on paste`
- `feat!(android): rework key derivation`
- `feat(server)+fix(windows): ...`
- `docs: update README`  ← no release

## Checklist
- [ ] PR title matches the format above
- [ ] **Description filled in** (becomes the release "What's New")
- [ ] Each scope lists every platform actually changed — no more, no less
- [ ] Tested locally on the platforms in scope
- [ ] Breaking change? `!` is in the title AND impact is described below
- [ ] No secrets, keystores, or `.env` files added to the diff

## Breaking changes (if any)
<!-- What breaks, who's affected, migration steps. Leave empty if not breaking. -->
