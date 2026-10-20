# Publishing to the VS Code Marketplace

The public listing is `README.md`. Internal setup stays in `docs-local/` (gitignored)
and is excluded from the VSIX.

## One-time: GitHub

1. Create an empty public repository `nuanst-one/vscode-litellm` (no README, no license — this repo already has both).
2. From this directory:

```bash
git remote add origin https://github.com/nuanst-one/vscode-litellm.git
git push -u origin main
```

`package.json` `repository`, `homepage`, `bugs`, and `qna` already point at that URL.
If the GitHub owner differs, change those four fields before packaging. `vsce` rewrites
relative README links against `repository` and assumes the `main` branch.

## One-time: publisher

1. Open <https://marketplace.visualstudio.com/manage/publishers> and sign in.
2. Create a publisher (or reuse **Nuanst One GmbH**). The `publisher` field must be the
   publisher **ID** (`nuanst-one`), not the display name. The ID cannot be changed later.
3. Confirm the extension name `vscode-litellm` is free under that publisher. Names are
   permanent once a version is published.

## Each release

```bash
npm install
npm test
npm run package          # writes vscode-litellm-<version>.vsix
npx vsce ls              # review exactly what the VSIX contains
```

`vsce package` runs `vscode:prepublish` (`npm run compile`) and checks the manifest:
license file, PNG icon (not SVG), README, description length, and https image URLs.

Bump `version` in `package.json` and add a `CHANGELOG.md` entry before every publish.
The doctor compares the running bundle's baked version with the installed extension,
so a version bump is what makes a stale window detectable.

### Publish

Global Azure DevOps personal access tokens are retired on **1 December 2026**.
Until then, a PAT with the Marketplace **Manage** scope still works:

```bash
# https://marketplace.visualstudio.com/manage — User settings → Personal access tokens
export VSCE_PAT=...
npm run publish
```

Or upload the `.vsix` by hand on the publisher management page.

After 1 December 2026, publish with Microsoft Entra ID (`vsce publish --azure-credential`).
Microsoft's steps: <https://code.visualstudio.com/api/working-with-extensions/publishing-extension>.

## Checklist

- [ ] `publisher` matches the marketplace publisher ID
- [ ] `repository` is the real public GitHub URL
- [ ] `version` bumped and `CHANGELOG.md` updated
- [ ] `LICENSE`, `README.md`, `CHANGELOG.md`, and `icon.png` (128×128 PNG) present
- [ ] README has no internal hostnames, paths, or keys (`docs-local/` stays untracked)
- [ ] `npx vsce ls` shows `dist/extension.js`, not `src/`, `test/`, or `node_modules/`
- [ ] `npm test` is green

## Open VSX (optional)

The same VSIX can be published for VS Code forks:

```bash
npx ovsx publish vscode-litellm-0.2.0.vsix --pat <OPENVSX_PAT>
```

Open VSX accepts the MIT license.
