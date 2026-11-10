---
name: Workspace CLI dependency resolution
description: Generated one-off runners must resolve dependencies from the package that declares them.
---

Keep dependency imports inside the workspace package that declares them; generated runners should call that package's exported helpers.

**Why:** A generated runner could not import `pg` from the project root even though the scripts workspace already had it installed. It failed before opening a spending gate.

**How to apply:** Put database connection factories in the scripts workspace and import those factories from generated runners. Do not install duplicate root dependencies to work around package resolution.
