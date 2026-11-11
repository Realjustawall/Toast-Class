# Supplied login design

The authentication layout and local 3D scene are adapted from the user's supplied `LOGIN DESIGN/index.html` and `LOGIN DESIGN/toaster-3d.js`. The original source files remain intact.

The scene contains Three.js r160, copyright 2010–2023 Three.js Authors (MIT), and an embedded font with Magenta's copyright and license. Their original notices and embedded license text remain in the distributed scene script. The animation runs in an isolated iframe, honors reduced motion, and requests no external resources.

`scripts/prepare-login-design.mjs` produces the static scene assets during development and production builds. `apps/web/src/login-design.css` scopes the supplied styles to authentication; the existing authenticated account API handles all registration and sign-in requests.
