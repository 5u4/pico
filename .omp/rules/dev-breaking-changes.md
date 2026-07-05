---
description: Rapid-dev, single-user — never preserve backward compatibility
alwaysApply: true
---

# Rapid dev: break freely, never preserve backward compatibility

This project is in a rapid-development phase with exactly one user (the
maintainer). There are no external consumers, no published API, no other
developers. So backward compatibility is a non-goal.

- **Never** avoid a change because it is "breaking". Breaking changes are fine.
- **Never** add a compatibility shim, alias, re-export, deprecation path,
  feature flag, or migration fallback "to keep the old thing working". Delete
  the old thing and move on.
- **Never** keep a renamed symbol/field/command under its old name. Rename it
  everywhere and update every caller in the same change — clean cutover.
- Data/schema migrations that drop and rebuild are acceptable; the maintainer
  rebuilds any state by hand. Don't write data-preservation code unless asked.

The one thing that still holds: the change must be **complete**. Clean cutover
means every caller is migrated in the same change, not that half of them are
left dangling. Break it, but don't leave it half-broken.
