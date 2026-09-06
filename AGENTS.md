# Versioning

- Update the version for every completed product correction or new feature, in the same change as its implementation. Do not leave product changes under an unchanged version.
- `manifest.json` is the source of truth. Keep `package.json` at exactly the same version. The popup reads the installed manifest; never hard-code a separate display version.
- Use `x.y.z`: increment the patch for fixes or visual/copy corrections (`0.2.0` → `0.2.1`); increment the minor and reset the patch for new features (`0.2.1` → `0.3.0`). A batch containing both uses a minor increase. Reserve major changes for explicitly planned breaking releases.
- Version each completed logical change, not each intermediate edit or review iteration. Documentation-only, tests-only, CI-only, and merge-only changes do not require a product version increase.
- Add a dated entry in `CHANGELOG.md` describing the change. Preserve historical release entries and tags. Version changes do not authorize commits, pushes, tags, or publication.
- Before finishing, run `npm run check`, `npm test`, and `git diff --check`; confirm the package and manifest versions match.

# Development server networking

- Bind development HTTP servers to `0.0.0.0` so they are reachable through the WSL network.
- Do not force a fixed port unless required. If the default port is occupied, use the next available port; never terminate another development server to reclaim it.
- After starting a server, determine and report its actual listening port and URL. Preserve HMR/WebSocket functionality.
