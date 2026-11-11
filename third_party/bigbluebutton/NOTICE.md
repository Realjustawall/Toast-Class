# BigBlueButton classroom layout adaptation

The classroom framing stylesheet `apps/web/src/classroom-shell.css` adapts layout patterns from the BigBlueButton open-source HTML5 client. Its adapted portions are identified as LGPL-3.0-only; this notice is an exception to the repository's general MIT license. Original TOASTER application/backend code retains its existing license. BigBlueButton names/logos are not used as TOASTER product branding.

Upstream project: https://github.com/bigbluebutton/bigbluebutton, branch `v4.0.x-develop`, reviewed2026-11-06. Copyright holders are the BigBlueButton project contributors as identified by upstream source/history. The upstream license texts are preserved here without modification. Unmodified reference source files are retained in `upstream/`; they are not executed by TOASTER.

| Source under `bigbluebutton-html5/imports/ui/components/` | Reviewed Git blob                          |
| --------------------------------------------------------- | ------------------------------------------ |
| `actions-bar/styles.js`                                   | `ee5bc51a1dc3bcbd6da86a5bc0fa2cb8f0027a58` |
| `nav-bar/styles.js`                                       | `09e1c69393cd8b18d03dc5e099ff359ed17cb818` |
| `sidebar-navigation/styles.ts`                            | `19d165520f1974a262dca768e3e2c4d6f1c44e2d` |
| `layout/defaultValues.js`                                 | `ced07deb1a8115e03a27e6f172759934b5b125ca` |

Modifications by TOASTER contributors: translated CSS-in-JS framing into a scoped CSS Grid layout; retained navigation/panel/stage/action-bar separation and start/center/end action groups; adapted spacing, colors, RTL, mobile behavior and controls to TOASTER's React/LiveKit/Yjs application. TOASTER's icon paths are independently authored. No BBB server, Meteor/GraphQL integration or proprietary Skyroom code is included by this adaptation.

The Docker web recipe includes this notice, both LGPL/GPL license texts, the reference sources and the unminified modified stylesheet under `/licenses/bigbluebutton/`. Replace or edit the stylesheet and rebuild with the documented web build command to modify/relink these styles. A numeric source-copy percentage is not asserted: it is not a meaningful substitute for checking visual/workflow fidelity. Full redistribution/source inventory review for all other dependencies remains a separate release gate.
